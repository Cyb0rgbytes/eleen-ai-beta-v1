/**
 * Requests through the real Worker, inside workerd, with its bindings.
 * Nothing here reaches a model: each case is decided before inference.
 */
import { describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { authorizedParties } from "../../src/lib/auth";
import { Bucket, RULES, rateLimitKey } from "../../src/lib/ratelimit";
import { cspMode, withSecurityHeaders } from "../../src/lib/security-headers";

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
		const csp = response.headers.get("content-security-policy") ?? "";
		const scripts = directive(csp, "script-src");
		expect(scripts).not.toContain("'unsafe-inline'");
		// 'unsafe-eval' is present only for the Spline viewer, which
		// evaluates a string internally; see security-headers.ts.
		expect(scripts.sort()).toEqual(
			[
				"'self'",
				"'unsafe-eval'",
				"https://*.client.protect.clerk.com",
				"https://cdn.protect.clerk.com",
				"https://challenges.cloudflare.com",
				"https://clerk.eleenai.xyz/npm/@clerk/clerk-js@5.128.0/",
				"https://static.cloudflareinsights.com",
				"https://unpkg.com/@splinetool/viewer@1.12.88/build/",
			].sort(),
		);
		// No bare CDN host: any package on it would be allowed (final audit #2).
		const connect = directive(csp, "connect-src");
		for (const host of ["https://unpkg.com", "https://unpkg.com/"]) {
			expect(scripts).not.toContain(host);
			expect(connect).not.toContain(host);
		}
		expect(scripts).not.toContain("https://clerk.eleenai.xyz");
		// Clerk's API lives under /v1 on the same host, so connect-src keeps the host.
		expect(connect).toContain("https://clerk.eleenai.xyz");
		expect(directive(csp, "font-src")).toEqual(["'self'"]);
		expect(directive(csp, "object-src")).toEqual(["'none'"]);
		expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
	});

	it("allows images only from the page, Clerk avatars and the Spline badge", async () => {
		const response = await fetchWorker("/api/v1/health");
		const csp = response.headers.get("content-security-policy") ?? "";
		const images = directive(csp, "img-src");
		// A bare https: would let injected markup exfiltrate by image URL.
		expect(images).not.toContain("https:");
		expect(images.sort()).toEqual(
			["'self'", "blob:", "data:", "https://app.spline.design", "https://img.clerk.com"].sort(),
		);
		expect(directive(csp, "connect-src")).toContain("https://fonts.gstatic.com");
	});

	it("enforces the main policy and only reports Trusted Types", async () => {
		const response = await fetchWorker("/api/v1/health");
		const enforced = response.headers.get("content-security-policy") ?? "";
		const reportOnly = response.headers.get("content-security-policy-report-only") ?? "";
		expect(enforced).toContain("default-src 'self'");
		expect(enforced).not.toContain("require-trusted-types-for");
		// Only the main policy reports to the Worker; see security-headers.ts.
		expect(enforced).toContain("report-uri /api/csp-report");
		expect(reportOnly).toBe("require-trusted-types-for 'script'");
	});

	it("goes back to Report-Only when CSP_MODE is report", () => {
		expect(cspMode("report")).toBe("report");
		expect(cspMode(undefined)).toBe("enforce");
		expect(cspMode("Report")).toBe("enforce");
		const page = new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } });
		const secured = withSecurityHeaders(page, new URL("https://eleenai.xyz/"), "report");
		expect(secured.headers.get("content-security-policy")).toBeNull();
		const policies = (secured.headers.get("content-security-policy-report-only") ?? "").split(",").map((p) => p.trim());
		expect(policies).toHaveLength(2);
		expect(policies[0]).toContain("default-src 'self'");
		expect(policies[1]).toBe("require-trusted-types-for 'script'");
	});

	it("keeps a policy a handler set itself", () => {
		const own = new Response("x", { headers: { "content-security-policy": "default-src 'none'" } });
		const secured = withSecurityHeaders(own, new URL("https://eleenai.xyz/x"));
		expect(secured.headers.get("content-security-policy")).toBe("default-src 'none'");
		expect(secured.headers.get("content-security-policy-report-only")).toBeNull();
	});

	// The nonce lets Cloudflare's injected JavaScript Detections script run
	// while every other inline script stays blocked.
	function securedPage(): string[] {
		const page = new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } });
		const header = withSecurityHeaders(page, new URL("https://eleenai.xyz/")).headers.get("content-security-policy");
		return directive(header ?? "", "script-src");
	}

	it("gives each HTML document a fresh, unguessable script nonce", () => {
		const first = securedPage().filter((s) => s.startsWith("'nonce-"));
		const second = securedPage().filter((s) => s.startsWith("'nonce-"));
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(first[0]).not.toEqual(second[0]);
		// 16 random bytes, base64: 24 characters inside 'nonce-â€¦'.
		expect(first[0]).toMatch(/^'nonce-[A-Za-z0-9+/]{22}=='$/);
		// The nonce adds to the allowlist; it never brings inline back.
		expect(securedPage()).not.toContain("'unsafe-inline'");
	});

	it("puts no nonce on API responses", async () => {
		const response = await fetchWorker("/api/v1/health");
		const csp = response.headers.get("content-security-policy") ?? "";
		expect(directive(csp, "script-src").some((s) => s.startsWith("'nonce-"))).toBe(false);
	});

	it("allows the Web Analytics beacon to report", async () => {
		const response = await fetchWorker("/api/v1/health");
		const csp = response.headers.get("content-security-policy") ?? "";
		expect(directive(csp, "connect-src")).toContain("https://cloudflareinsights.com");
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

describe("voice output routes", () => {
	const json = (ip: string) => ({ "content-type": "application/json", "cf-connecting-ip": ip });

	it("requires sign-in on the full-tier route", async () => {
		const response = await fetchWorker("/api/voice/speak", {
			method: "POST",
			headers: json("203.0.113.20"),
			body: JSON.stringify({ text: "Hello" }),
		});
		expect(response.status).toBe(401);
	});

	it("refuses empty text on the guest route", async () => {
		const response = await fetchWorker("/api/voice/speak/guest", {
			method: "POST",
			headers: json("203.0.113.21"),
			body: JSON.stringify({ text: "" }),
		});
		expect(response.status).toBe(422);
	});

	it("is metered by its own speak bucket", async () => {
		const ip = "203.0.113.22";
		await exhaustGuest("speak", ip);
		const response = await fetchWorker("/api/voice/speak/guest", {
			method: "POST",
			headers: json(ip),
			body: JSON.stringify({ text: "Hello" }),
		});
		expect(response.status).toBe(429);
	});

	it("lets the page play spoken replies from blob: URLs and nowhere else", async () => {
		const response = await fetchWorker("/api/v1/health");
		const csp = response.headers.get("content-security-policy") ?? "";
		const media = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("media-src "));
		expect(media?.split(/\s+/).slice(1).sort()).toEqual(["'self'", "blob:"]);
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
	it("refuses inline attachments before any inference, for guests and users alike", async () => {
		for (const attachments of [
			[{ data: "PHNjcmlwdD4=", mimeType: "text/html", name: "x.html" }],
			[1, 2, 3, 4, 5].map(() => ({ data: "iVBORw0KGgo=", mimeType: "image/png", name: "p.png" })),
		]) {
			const response = await fetchWorker("/api/chat/guest", {
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
				body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], attachments }),
			});
			expect(response.status).toBe(422);
			expect(await response.text()).toContain("/api/v1/files");
		}
	});

	it("does not sign a request in from a session cookie alone", async () => {
		for (const path of ["/api/chat", "/api/v1/conversations", "/api/v1/files"]) {
			const response = await fetchWorker(path, {
				method: "POST",
				// What a cross-site form would send: a cookie and a "simple" body.
				headers: { "content-type": "text/plain", cookie: "__session=x.y.z; __client_uat=1" },
				body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
			});
			expect(response.status, path).toBe(401);
		}
	});
});

describe("hardening (final audit)", () => {
	const report = (blocked: string) =>
		JSON.stringify({ "csp-report": { "violated-directive": "script-src", "blocked-uri": blocked, "document-uri": "https://eleenai.xyz/" } });

	it("logs a CSP report with each field capped, and only for report content types", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const ok = await fetchWorker("/api/csp-report", {
				method: "POST",
				headers: { "content-type": "application/csp-report", "cf-connecting-ip": "203.0.113.20" },
				body: report(`https://x.example/${"a".repeat(5000)}`),
			});
			expect(ok.status).toBe(204);
			const logged = warn.mock.calls.find((c) => c[0] === "CSP violation")?.[1] as Record<string, string>;
			expect(logged.directive).toBe("script-src");
			expect(logged.blocked.length).toBeLessThanOrEqual(256);

			warn.mockClear();
			const plain = await fetchWorker("/api/csp-report", {
				method: "POST",
				headers: { "content-type": "text/plain", "cf-connecting-ip": "203.0.113.20" },
				body: report("https://x.example/"),
			});
			expect(plain.status).toBe(204);
			expect(warn.mock.calls.some((c) => c[0] === "CSP violation")).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	it("ignores an oversized CSP report without reading it into the log", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const big = await fetchWorker("/api/csp-report", {
				method: "POST",
				headers: { "content-type": "application/csp-report", "cf-connecting-ip": "203.0.113.21" },
				body: report(`https://x.example/${"a".repeat(64 * 1024)}`),
			});
			expect(big.status).toBe(204);
			expect(warn.mock.calls.some((c) => c[0] === "CSP violation")).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	it("gives the asset host no credentialed CORS", async () => {
		const preflight = await fetchWorker("/api/v1/conversations", {
			method: "OPTIONS",
			headers: { origin: "https://assets.eleenai.xyz", "access-control-request-method": "GET" },
		});
		expect(preflight.status).toBe(403);
		const site = await fetchWorker("/api/v1/conversations", {
			method: "OPTIONS",
			headers: { origin: "https://eleenai.xyz", "access-control-request-method": "GET" },
		});
		expect(site.headers.get("access-control-allow-origin")).toBe("https://eleenai.xyz");
	});

	it("accepts localhost tokens only when the Worker itself runs on localhost", () => {
		expect(authorizedParties(new URL("https://eleenai.xyz/api/chat"))).toEqual(["https://eleenai.xyz"]);
		expect(authorizedParties(new URL("https://eleen-ai-beta-v1.example.workers.dev/api/chat"))).toEqual(["https://eleenai.xyz"]);
		expect(authorizedParties(new URL("http://localhost:8787/api/chat"))).toContain("http://localhost:8787");
		expect(authorizedParties(new URL("http://127.0.0.1:8787/api/chat"))).toContain("http://localhost:8787");
	});
});
