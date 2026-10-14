/**
 * Requests through the real Worker, inside workerd, with its bindings.
 * Nothing here reaches a model: each case is decided before inference.
 */
import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { Bucket, RULES, rateLimitKey } from "../../src/lib/ratelimit";

const ORIGIN = "https://eleenai.xyz";

function fetchWorker(path: string, init?: RequestInit) {
	return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

/** Spend a guest's whole allowance in a bucket, as ratelimit.ts counts it. */
async function exhaustGuest(bucket: Bucket, ip: string): Promise<void> {
	const request = new Request(ORIGIN, { headers: { "cf-connecting-ip": ip } });
	const { key, windowStart } = await rateLimitKey(request, bucket, "guest");
	await env.DB.prepare(
		"INSERT INTO usage_counters (key, window_start, units, expires_at) VALUES (?, ?, ?, ?)",
	)
		.bind(key, windowStart, RULES[bucket].guest.limit, windowStart + 7200)
		.run();
}

describe("D1", () => {
	it("has the migrated schema", async () => {
		const { results } = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_counters'",
		).all();
		expect(results).toHaveLength(1);
	});
});

describe("health", () => {
	it("answers without auth", async () => {
		const response = await fetchWorker("/api/v1/health");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string };
		expect(body.status).toBeTruthy();
	});
});

describe("MCP rate limiting", () => {
	// Regression for the audit finding: tools/call reached the handlers with
	// no rate limit at all, so /mcp was an unmetered path to inference.
	it("refuses a guest tool call once the chat bucket is spent", async () => {
		const ip = "203.0.113.7";
		await exhaustGuest("chat", ip);

		const response = await fetchWorker("/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": ip },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "eleenai_chat", arguments: { message: "hello" } },
			}),
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { isError?: boolean; content: { text: string }[] };
		};
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toMatch(/rate limit/i);
	});

	it("rejects a malformed bearer token instead of falling back to guest", async () => {
		const response = await fetchWorker("/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "eleenai_chat", arguments: { message: "hello" } },
			}),
		});
		expect(response.status).toBe(401);
	});
});

describe("chat validation", () => {
	it("rejects an attachment type the handler cannot read, before any inference", async () => {
		const response = await fetchWorker("/api/chat/guest", {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
				attachments: [{ data: "PHNjcmlwdD4=", mimeType: "text/html", name: "x.html" }],
			}),
		});
		expect(response.status).toBe(422);
	});
});
