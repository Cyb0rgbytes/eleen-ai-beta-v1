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
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('usage_counters', 'provider_keys') ORDER BY name",
		).all<{ name: string }>();
		expect(results.map((r) => r.name)).toEqual(["provider_keys", "usage_counters"]);
	});
});

describe("provider keys route", () => {
	it("requires sign-in for every method", async () => {
		for (const method of ["GET", "PUT", "DELETE"]) {
			const response = await fetchWorker("/api/v1/keys", {
				method,
				headers: { "content-type": "application/json" },
				body: method === "GET" ? undefined : JSON.stringify({ provider: "openai", key: "sk-x" }),
			});
			expect(response.status, method).toBe(401);
		}
	});

	it("answers a request with no credentials without needing Clerk", async () => {
		// Runs with no CLERK_SECRET_KEY in CI: the gate must not reach Clerk
		// for a request that carries nothing to verify.
		const response = await fetchWorker("/api/v1/keys");
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
	});

	it("treats an unverifiable token as signed out, never a 500", async () => {
		const response = await fetchWorker("/api/v1/keys", { headers: { authorization: "Bearer not-a-real-token" } });
		expect([401, 503]).toContain(response.status);
	});

	it("refuses methods it does not serve", async () => {
		const response = await fetchWorker("/api/v1/keys", { method: "POST" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toContain("PUT");
	});

	it("never has a plaintext key in the database after a store", async () => {
		// Exercise the store directly: the route needs a Clerk token, which no
		// test has. What matters is the invariant on the row.
		const { storeKey, loadKey } = await import("../../src/lib/keys");
		const master = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
		const testEnv = { ...env, KEY_ENCRYPTION_KEY: master } as unknown as import("../../src/types").Env;
		const key = "sk-ant-" + "q".repeat(40);

		await storeKey(testEnv, "user_test", "anthropic", key, null);

		const row = await env.DB.prepare("SELECT * FROM provider_keys WHERE user_id = 'user_test'").first<
			Record<string, unknown>
		>();
		expect(row).toBeTruthy();
		expect(JSON.stringify(row)).not.toContain(key);
		expect(row!.last4).toBe("qqqq");
		expect(await loadKey(testEnv, "user_test", "anthropic")).toBe(key);
		expect(await loadKey(testEnv, "someone_else", "anthropic")).toBeNull();
	});
});

describe("content security policy", () => {
	function directive(csp: string, name: string): string[] {
		const found = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
		return found ? found.split(/\s+/).slice(1) : [];
	}

	it("allows no inline script, and only the known script hosts", async () => {
		const response = await fetchWorker("/api/v1/health");
		const csp = response.headers.get("content-security-policy-report-only") ?? "";
		const scripts = directive(csp, "script-src");
		expect(scripts).not.toContain("'unsafe-inline'");
		// 'unsafe-eval' is present only for the Spline viewer, which
		// evaluates a string internally; see security-headers.ts.
		expect(scripts.sort()).toEqual(
			[
				"'self'",
				"'unsafe-eval'",
				"https://cdn.protect.clerk.com",
				"https://challenges.cloudflare.com",
				"https://clerk.eleenai.xyz",
				"https://unpkg.com",
			].sort(),
		);
		expect(directive(csp, "font-src")).toEqual(["'self'"]);
		expect(directive(csp, "object-src")).toEqual(["'none'"]);
		expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
	});

	it("allows images only from the page, Clerk avatars and the Spline badge", async () => {
		const response = await fetchWorker("/api/v1/health");
		const csp = response.headers.get("content-security-policy-report-only") ?? "";
		const images = directive(csp, "img-src");
		// A bare https: would let injected markup exfiltrate by image URL.
		expect(images).not.toContain("https:");
		expect(images.sort()).toEqual(
			["'self'", "blob:", "data:", "https://app.spline.design", "https://img.clerk.com"].sort(),
		);
		expect(directive(csp, "connect-src")).toContain("https://fonts.gstatic.com");
	});

	it("reports Trusted Types as a separate policy", async () => {
		const response = await fetchWorker("/api/v1/health");
		const header = response.headers.get("content-security-policy-report-only") ?? "";
		const policies = header.split(",").map((p) => p.trim());
		expect(policies).toHaveLength(2);
		expect(policies[1]).toContain("require-trusted-types-for 'script'");
		expect(policies[0]).not.toContain("require-trusted-types-for");
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

	it("sends a guest asking for a user-key model to sign in, before any provider call", async () => {
		const response = await fetchWorker("/api/chat/guest", {
			method: "POST",
			headers,
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "openai/gpt-5.5" }),
		});
		expect(response.status).toBe(403);
		const body = (await response.json()) as { reason: string };
		expect(body.reason).toBe("sign-in");
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
