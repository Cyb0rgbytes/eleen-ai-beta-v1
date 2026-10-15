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

describe("voice transcription routes", () => {
	it("requires sign-in on the full-tier route", async () => {
		const response = await fetchWorker("/api/voice/transcribe", {
			method: "POST",
			headers: { "content-type": "audio/webm" },
			body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
		});
		expect(response.status).toBe(401);
	});

	it("refuses a non-audio upload on the guest route", async () => {
		const response = await fetchWorker("/api/voice/transcribe/guest", {
			method: "POST",
			headers: { "content-type": "audio/webm", "cf-connecting-ip": "203.0.113.9" },
			body: "<html>not audio</html>",
		});
		expect(response.status).toBe(415);
	});

	it("is metered by the voice bucket", async () => {
		const ip = "203.0.113.10";
		await exhaustGuest("voice", ip);
		const response = await fetchWorker("/api/voice/transcribe/guest", {
			method: "POST",
			headers: { "content-type": "audio/webm", "cf-connecting-ip": ip },
			body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
		});
		expect(response.status).toBe(429);
	});
});

describe("models", () => {
	it("lists the registry without auth and names the default", async () => {
		const response = await fetchWorker("/api/v1/models");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			default: string;
			models: { id: string; tier: string; access: string }[];
		};
		expect(body.default).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
		expect(body.models.find((m) => m.id === body.default)?.access).toBe("guest");
		expect(body.models.find((m) => m.tier === "reasoning")?.access).toBe("sign-in");
		expect(body.models.some((m) => m.access === "key-required")).toBe(true);
	});

	it("filters by tier", async () => {
		const response = await fetchWorker("/api/v1/models?tier=smart");
		const body = (await response.json()) as { models: { tier: string }[] };
		expect(body.models.length).toBeGreaterThan(0);
		expect(body.models.every((m) => m.tier === "smart")).toBe(true);
	});
});

describe("chat model selection", () => {
	const headers = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" };

	it("rejects an unknown model before any inference", async () => {
		const response = await fetchWorker("/api/chat/guest", {
			method: "POST",
			headers,
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "@cf/nope/x" }),
		});
		expect(response.status).toBe(422);
	});

	it("rejects an unknown protocol", async () => {
		const response = await fetchWorker("/api/chat/guest", {
			method: "POST",
			headers,
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], protocol: 3 }),
		});
		expect(response.status).toBe(422);
	});

	it("keeps the reasoning tier for signed-in users", async () => {
		const response = await fetchWorker("/api/chat/guest", {
			method: "POST",
			headers,
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "reasoning" }),
		});
		expect(response.status).toBe(403);
		const body = (await response.json()) as { reason: string };
		expect(body.reason).toBe("sign-in");
	});

	it("refuses a user-key model before any provider call", async () => {
		const response = await fetchWorker("/api/chat/guest", {
			method: "POST",
			headers,
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "openai/gpt-5.5" }),
		});
		expect(response.status).toBe(403);
		const body = (await response.json()) as { reason: string };
		expect(body.reason).toBe("key-required");
	});

	it("passes an MCP tier argument through to the same checks", async () => {
		const response = await fetchWorker("/mcp", {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "eleenai_chat", arguments: { message: "hello", tier: "reasoning" } },
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { isError?: boolean; content: { text: string }[] };
		};
		expect(body.result.isError).toBe(true);
		expect(body.result.content[0].text).toMatch(/signed-in/i);
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
