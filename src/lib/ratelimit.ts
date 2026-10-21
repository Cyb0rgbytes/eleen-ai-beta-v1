/**
 * Per-caller rate limiting.
 *
 * Two layers:
 *
 * 1. Hourly quotas in D1 (migrations/0001_usage.sql). Each check is one
 *    conditional upsert, so the read and the increment cannot be separated —
 *    the KV counters this replaces read a count and wrote count + 1 later, and
 *    concurrent requests all read the same count and all got through. Quotas
 *    are counted in units, so an expensive request can cost more than one.
 *
 * 2. A burst guard on the Workers Rate Limiting binding: a short per-caller
 *    ceiling across every bucket, so a quota cannot be spent in one second.
 *    It is local to each Cloudflare location and approximate by design, which
 *    is fine for a burst guard and is why it is not the quota.
 *
 * A limit a client enforces against itself is not a limit: everything here is
 * keyed on the authenticated user, or a hashed IP for guests.
 */
import { Env } from "../types";

export interface RateLimitRule {
	/** Units permitted within the window. 0 means the tier has no access. */
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

interface BucketRules {
	guest: RateLimitRule;
	user: RateLimitRule;
	/**
	 * What a guest gets when the counter store is unreachable. Buckets that
	 * call a paid third-party API refuse rather than run unmetered; cheap ones
	 * stay up, because an outage should degrade the guard before the site.
	 */
	failClosedForGuests: boolean;
}

const HOUR = 3600;

export const RULES = {
	chat: {
		guest: { limit: 20, windowSeconds: HOUR },
		user: { limit: 200, windowSeconds: HOUR },
		failClosedForGuests: false,
	},
	image: {
		guest: { limit: 5, windowSeconds: HOUR },
		user: { limit: 50, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
	vision: {
		guest: { limit: 10, windowSeconds: HOUR },
		user: { limit: 100, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
	search: {
		guest: { limit: 10, windowSeconds: HOUR },
		user: { limit: 100, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
	enhance: {
		guest: { limit: 15, windowSeconds: HOUR },
		user: { limit: 100, windowSeconds: HOUR },
		failClosedForGuests: false,
	},
	voice: {
		guest: { limit: 10, windowSeconds: HOUR },
		user: { limit: 60, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
	// Spoken replies. Aura bills per character on the owner's account, so
	// guests refuse rather than run unmetered when the counter is down.
	speak: {
		guest: { limit: 10, windowSeconds: HOUR },
		user: { limit: 60, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
	// File uploads and multi-model compare are for signed-in users only.
	upload: {
		guest: { limit: 0, windowSeconds: HOUR },
		user: { limit: 30, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
	compare: {
		guest: { limit: 0, windowSeconds: HOUR },
		user: { limit: 30, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
	// Storing a provider key makes one call to that provider to check it.
	keys: {
		guest: { limit: 0, windowSeconds: HOUR },
		user: { limit: 20, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
	// Conversation history, folders, search, consent and memory. Database
	// reads and writes only, no inference, so the ceiling is generous: the
	// sidebar alone makes several calls per page load. Guests have no history.
	history: {
		guest: { limit: 0, windowSeconds: HOUR },
		user: { limit: 600, windowSeconds: HOUR },
		failClosedForGuests: true,
	},
} satisfies Record<string, BucketRules>;

export type Bucket = keyof typeof RULES;

/** Rows are kept one window past their own, then pruned. */
const PRUNE_PROBABILITY = 0.02;

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function windowStart(windowSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): number {
	return Math.floor(nowSeconds / windowSeconds) * windowSeconds;
}

/**
 * Who is being counted. Guests are a hashed IP — salted with the window, so a
 * stored key cannot be linked to the same address across windows and no raw
 * address is ever written.
 */
async function callerIdentity(request: Request, userId: string, salt: number): Promise<string> {
	if (userId !== "guest") return `u:${userId}`;
	const ip = request.headers.get("cf-connecting-ip") || "unknown";
	return `ip:${(await sha256Hex(`${ip}:${salt}`)).slice(0, 32)}`;
}

/** The counter key for a caller in a bucket. Exported for tests. */
export async function rateLimitKey(
	request: Request,
	bucket: Bucket,
	userId: string,
): Promise<{ key: string; windowStart: number }> {
	const rule = userId === "guest" ? RULES[bucket].guest : RULES[bucket].user;
	const start = windowStart(rule.windowSeconds);
	return { key: `${bucket}:${await callerIdentity(request, userId, start)}`, windowStart: start };
}

/**
 * Add `units` to the counter only if the result stays within the limit.
 *
 * When the WHERE clause fails the update is skipped and RETURNING yields no
 * row, so "no row" means refused — the check and the increment are a single
 * statement and cannot interleave with another request's.
 */
const CONSUME_SQL = `
INSERT INTO usage_counters (key, window_start, units, expires_at)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (key, window_start) DO UPDATE
	SET units = units + excluded.units
	WHERE units + excluded.units <= ?5
RETURNING units`;

export async function checkRateLimit(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	bucket: Bucket,
	userId: string,
	cost = 1,
): Promise<RateLimitResult> {
	const rules: BucketRules = RULES[bucket];
	const rule = userId === "guest" ? rules.guest : rules.user;
	const now = Math.floor(Date.now() / 1000);
	const start = windowStart(rule.windowSeconds, now);
	const resetSeconds = start + rule.windowSeconds - now;

	const refused: RateLimitResult = { allowed: false, limit: rule.limit, remaining: 0, resetSeconds };

	// A request that could never fit — or a tier with no access at all.
	if (cost > rule.limit) return refused;

	const identity = await callerIdentity(request, userId, start);

	// Burst guard first: it is in-memory and cheap, and it stops a flood
	// before every request in it costs a database write.
	if (env.BURST) {
		const { success } = await env.BURST.limit({ key: identity });
		if (!success) return { ...refused, resetSeconds: 10 };
	}

	let units: number | null;
	try {
		const row = await env.DB.prepare(CONSUME_SQL)
			.bind(`${bucket}:${identity}`, start, cost, start + rule.windowSeconds * 2, rule.limit)
			.first<{ units: number }>();
		units = row?.units ?? null;
	} catch (error) {
		console.error("Rate limit store unavailable:", error);
		const failClosed = userId === "guest" && rules.failClosedForGuests;
		return failClosed
			? refused
			: { allowed: true, limit: rule.limit, remaining: rule.limit, resetSeconds };
	}

	if (Math.random() < PRUNE_PROBABILITY) {
		ctx.waitUntil(
			env.DB.prepare("DELETE FROM usage_counters WHERE expires_at < ?1")
				.bind(now)
				.run()
				.catch((error) => console.error("Rate limit prune failed:", error)),
		);
	}

	if (units === null) return refused;

	return {
		allowed: true,
		limit: rule.limit,
		remaining: Math.max(rule.limit - units, 0),
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
