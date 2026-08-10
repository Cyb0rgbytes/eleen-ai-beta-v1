/**
 * Per-caller rate limiting.
 *
 * This is the real fix for the guest cap, which until now lived entirely in
 * the browser's localStorage — a limit a client enforces against itself is not
 * a limit. Every guest endpoint could be driven from curl without bound, and
 * each one spends inference budget.
 *
 * Backed by the existing KV namespace rather than a new binding, so it needs
 * no infrastructure change to deploy. KV is eventually consistent, so a caller
 * racing many requests through different edge locations can overshoot the
 * quota somewhat. That is an acceptable trade for a budget guard: it turns
 * unbounded abuse into bounded overshoot. A hard limit would need Durable
 * Objects or the Rate Limiting binding.
 */
import { Env } from "../types";

export interface RateLimitRule {
	/** Requests permitted within the window. */
	limit: number;
	/** Window length in seconds. */
	windowSeconds: number;
}

export interface RateLimitResult {
	allowed: boolean;
	limit: number;
	remaining: number;
	/** Seconds until the window resets. */
	resetSeconds: number;
}

/**
 * Guest limits are per-IP and deliberately tight — these endpoints are
 * unauthenticated and each one costs inference. Authenticated limits are
 * per-user and generous enough not to interfere with real use.
 */
export const RULES: Record<string, { guest: RateLimitRule; user: RateLimitRule }> = {
	chat: {
		guest: { limit: 20, windowSeconds: 3600 },
		user: { limit: 200, windowSeconds: 3600 },
	},
	image: {
		guest: { limit: 5, windowSeconds: 3600 },
		user: { limit: 50, windowSeconds: 3600 },
	},
	vision: {
		guest: { limit: 10, windowSeconds: 3600 },
		user: { limit: 100, windowSeconds: 3600 },
	},
	search: {
		guest: { limit: 10, windowSeconds: 3600 },
		user: { limit: 100, windowSeconds: 3600 },
	},
	enhance: {
		guest: { limit: 15, windowSeconds: 3600 },
		user: { limit: 100, windowSeconds: 3600 },
	},
};

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Build the counter key.
 *
 * Guest identity is the client IP, hashed so a raw address is never written to
 * storage. The window index is part of the key, which makes expiry implicit —
 * a new window is simply a different key.
 */
async function buildKey(
	request: Request,
	bucket: string,
	userId: string,
	windowSeconds: number,
): Promise<string> {
	const window = Math.floor(Date.now() / 1000 / windowSeconds);

	if (userId !== "guest") {
		return `rl:v1:${bucket}:u:${userId}:${window}`;
	}

	const ip = request.headers.get("cf-connecting-ip") || "unknown";
	const hashed = (await sha256Hex(`${ip}:${window}`)).slice(0, 32);
	return `rl:v1:${bucket}:ip:${hashed}:${window}`;
}

export async function checkRateLimit(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	bucket: keyof typeof RULES,
	userId: string,
): Promise<RateLimitResult> {
	const rule = userId === "guest" ? RULES[bucket].guest : RULES[bucket].user;

	// Without the namespace bound there is nothing to count in. Failing open
	// is deliberate: a storage outage should degrade the guard, not the site.
	if (!env.ELEEN_MEMORY) {
		return { allowed: true, limit: rule.limit, remaining: rule.limit, resetSeconds: 0 };
	}

	const key = await buildKey(request, bucket, userId, rule.windowSeconds);
	const elapsed = Math.floor(Date.now() / 1000) % rule.windowSeconds;
	const resetSeconds = rule.windowSeconds - elapsed;

	let count = 0;
	try {
		count = Number((await env.ELEEN_MEMORY.get(key)) || "0");
		if (!Number.isFinite(count) || count < 0) count = 0;
	} catch (error) {
		console.error("Rate limit read failed:", error);
		return { allowed: true, limit: rule.limit, remaining: rule.limit, resetSeconds };
	}

	if (count >= rule.limit) {
		return { allowed: false, limit: rule.limit, remaining: 0, resetSeconds };
	}

	// Written in the background: the caller should not wait on the counter, and
	// a failed write costs at most one uncounted request.
	ctx.waitUntil(
		env.ELEEN_MEMORY.put(key, String(count + 1), {
			// Outlive the window so a counter cannot expire mid-window and
			// silently reset the allowance.
			expirationTtl: Math.max(rule.windowSeconds * 2, 60),
		}).catch((error) => console.error("Rate limit write failed:", error)),
	);

	return {
		allowed: true,
		limit: rule.limit,
		remaining: Math.max(rule.limit - count - 1, 0),
		resetSeconds,
	};
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
	return {
		"RateLimit-Limit": String(result.limit),
		"RateLimit-Remaining": String(result.remaining),
		"RateLimit-Reset": String(result.resetSeconds),
	};
}

export function tooManyRequests(result: RateLimitResult): Response {
	return new Response(
		JSON.stringify({
			error: "Rate limit exceeded. Please try again later.",
			retryAfterSeconds: result.resetSeconds,
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"Retry-After": String(result.resetSeconds),
				...rateLimitHeaders(result),
			},
		},
	);
}
