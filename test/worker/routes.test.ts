/**
 * Requests through the real Worker, inside workerd, with its bindings.
 * Nothing here reaches a model: each case is decided before inference.
 */
import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { RULES } from "../../src/lib/ratelimit";

const ORIGIN = "https://eleenai.xyz";

function fetchWorker(path: string, init?: RequestInit) {
	return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** The KV key ratelimit.ts uses for a guest, so a test can pre-spend it. */
async function guestKey(bucket: string, ip: string): Promise<string> {
	const windowSeconds = RULES[bucket].guest.windowSeconds;
	const window = Math.floor(Date.now() / 1000 / windowSeconds);
	const hashed = (await sha256Hex(`${ip}:${window}`)).slice(0, 32);
	return `rl:v1:${bucket}:ip:${hashed}:${window}`;
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
		await env.ELEEN_MEMORY.put(await guestKey("chat", ip), String(RULES.chat.guest.limit));

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
