import { describe, expect, it } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { RULES, checkRateLimit } from "../../src/lib/ratelimit";
import type { Env } from "../../src/types";

// The quota tests run without the burst guard: it allows 15 requests per 10
// seconds per caller, and would otherwise be what refuses the 16th request
// in a test about the hourly quota. The guard has its own test below.
const appEnv = { ...(env as unknown as Env), BURST: undefined } as Env;

function guestRequest(ip: string): Request {
	return new Request("https://eleenai.xyz/api/chat/guest", {
		method: "POST",
		headers: { "cf-connecting-ip": ip },
	});
}

const userRequest = new Request("https://eleenai.xyz/api/chat", { method: "POST" });

describe("D1 quota", () => {
	it("allows a guest up to the limit, then refuses", async () => {
		const ctx = createExecutionContext();
		const limit = RULES.chat.guest.limit;
		const results = [];
		for (let i = 0; i < limit + 2; i++) {
			results.push(await checkRateLimit(guestRequest("198.51.100.1"), appEnv, ctx, "chat", "guest"));
		}
		expect(results.slice(0, limit).every((r) => r.allowed)).toBe(true);
		expect(results[limit - 1].remaining).toBe(0);
		expect(results.slice(limit).every((r) => !r.allowed)).toBe(true);
	});

	it("counts guests separately by IP", async () => {
		const ctx = createExecutionContext();
		for (let i = 0; i < RULES.image.guest.limit; i++) {
			await checkRateLimit(guestRequest("198.51.100.2"), appEnv, ctx, "image", "guest");
		}
		const other = await checkRateLimit(guestRequest("198.51.100.3"), appEnv, ctx, "image", "guest");
		expect(other.allowed).toBe(true);
	});

	it("never lets concurrent requests overshoot", async () => {
		// The regression this table exists for: KV read-then-write let every
		// request in a concurrent burst see the same count.
		const ctx = createExecutionContext();
		const results = await Promise.all(
			Array.from({ length: 40 }, () =>
				checkRateLimit(guestRequest("198.51.100.4"), appEnv, ctx, "chat", "guest"),
			),
		);
		expect(results.filter((r) => r.allowed)).toHaveLength(RULES.chat.guest.limit);
	});

	it("charges a request its cost in units", async () => {
		const ctx = createExecutionContext();
		const limit = RULES.chat.user.limit;
		const cost = limit / 4;
		const results = [];
		for (let i = 0; i < 5; i++) {
			results.push(await checkRateLimit(userRequest, appEnv, ctx, "chat", "user_cost", cost));
		}
		expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, false]);
		expect(results[1].remaining).toBe(limit - 2 * cost);
	});

	it("refuses a request that could never fit", async () => {
		const ctx = createExecutionContext();
		const result = await checkRateLimit(
			userRequest, appEnv, ctx, "chat", "user_big", RULES.chat.user.limit + 1,
		);
		expect(result.allowed).toBe(false);
	});

	it("gives guests no access to signed-in-only buckets", async () => {
		const ctx = createExecutionContext();
		for (const bucket of ["upload", "compare"] as const) {
			const result = await checkRateLimit(guestRequest("198.51.100.5"), appEnv, ctx, bucket, "guest");
			expect(result.allowed).toBe(false);
		}
	});
});

describe("when the counter store is down", () => {
	const brokenEnv = {
		...appEnv,
		DB: {
			prepare() {
				throw new Error("D1 unavailable");
			},
		},
	} as unknown as Env;

	it("refuses guests on buckets that call paid APIs", async () => {
		const ctx = createExecutionContext();
		for (const bucket of ["image", "vision", "search", "voice"] as const) {
			const result = await checkRateLimit(guestRequest("198.51.100.6"), brokenEnv, ctx, bucket, "guest");
			expect(result.allowed, bucket).toBe(false);
		}
	});

	it("keeps cheap guest buckets and signed-in users working", async () => {
		const ctx = createExecutionContext();
		expect((await checkRateLimit(guestRequest("198.51.100.7"), brokenEnv, ctx, "chat", "guest")).allowed).toBe(true);
		expect((await checkRateLimit(userRequest, brokenEnv, ctx, "image", "user_x")).allowed).toBe(true);
	});
});

describe("burst guard", () => {
	it("refuses once the binding says no, before touching D1", async () => {
		const ctx = createExecutionContext();
		const deniedEnv = {
			...appEnv,
			BURST: { limit: async () => ({ success: false }) },
			DB: {
				prepare() {
					throw new Error("D1 must not be reached");
				},
			},
		} as unknown as Env;
		const result = await checkRateLimit(guestRequest("198.51.100.8"), deniedEnv, ctx, "chat", "guest");
		expect(result.allowed).toBe(false);
		expect(result.resetSeconds).toBe(10);
	});
});
