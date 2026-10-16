import { afterEach, describe, expect, it, vi } from "vitest";
import { createEncoder } from "../../../src/ai/sse";
import { ApiError, errorFromResponse, request, setTokenProvider, streamChat } from "./client";

afterEach(() => {
	vi.unstubAllGlobals();
	setTokenProvider(async () => null);
});

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("errorFromResponse", () => {
	it("reads Retry-After on 429", async () => {
		const e = await errorFromResponse(json(429, { error: "slow down" }, { "retry-after": "37" }));
		expect(e.kind).toBe("rate-limited");
		expect(e.retryAfter).toBe(37);
		expect(e.message).toBe("slow down");
	});

	it("carries the reason a model is forbidden", async () => {
		const e = await errorFromResponse(json(403, { error: "no", model: "m", reason: "key-required" }));
		expect(e.kind).toBe("forbidden");
		expect(e.reason).toBe("key-required");
	});

	it("classifies validation and server failures", async () => {
		expect((await errorFromResponse(json(422, { error: "bad" }))).kind).toBe("validation");
		expect((await errorFromResponse(new Response("oops", { status: 500 }))).kind).toBe("server");
		expect((await errorFromResponse(json(401, {}))).kind).toBe("unauthorized");
	});
});

describe("request", () => {
	it("adds the bearer token only when asked", async () => {
		const seen: (string | null)[] = [];
		vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
			seen.push(new Headers(init.headers).get("authorization"));
			return json(200, {});
		});
		setTokenProvider(async () => "tok_123");
		await request("/api/x", { auth: true });
		await request("/api/x");
		expect(seen).toEqual(["Bearer tok_123", null]);
	});

	it("never puts the request body into an error", async () => {
		const secret = "sk-ant-" + "s".repeat(40);
		vi.stubGlobal("fetch", async () => json(422, { error: "anthropic rejected this key." }));
		const error = (await request("/api/v1/keys", {
			method: "PUT",
			body: { provider: "anthropic", key: secret },
		}).catch((e: unknown) => e)) as ApiError;
		expect(error).toBeInstanceOf(ApiError);
		expect(JSON.stringify({ ...error, message: error.message, stack: error.stack })).not.toContain(secret);
	});

	it("reports a cancelled request as aborted, not as a network failure", async () => {
		vi.stubGlobal("fetch", (_u: URL, init: RequestInit) =>
			new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))),
		);
		const controller = new AbortController();
		const pending = request("/api/x", { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "aborted" });
	});

	it("times out a request whose headers never arrive", async () => {
		vi.stubGlobal("fetch", (_u: URL, init: RequestInit) =>
			new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("x", "TimeoutError")))),
		);
		await expect(request("/api/x", { timeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" });
	});
});

describe("streamChat", () => {
	it("asks for protocol 2 on the right route and yields its events", async () => {
		let sent: { url: string; body: unknown } | null = null;
		const v2 = createEncoder(2);
		vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
			sent = { url: url.pathname, body: JSON.parse(String(init.body)) };
			return new Response(v2.meta({ model: "m" }) + v2.token("hi") + v2.done(), {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const types: string[] = [];
		for await (const e of streamChat({ messages: [{ role: "user", content: "q" }] }, { authenticated: false })) {
			types.push(e.type);
		}
		expect(sent).toEqual({ url: "/api/chat/guest", body: { messages: [{ role: "user", content: "q" }], protocol: 2 } });
		expect(types).toEqual(["meta", "token", "done"]);
	});
});
