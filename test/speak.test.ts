import { describe, expect, it, vi } from "vitest";
import { MAX_SPEAK_CHARS, handleSpeak } from "../src/ai/speak";
import type { Env } from "../src/types";

function envWith(run: (...args: unknown[]) => unknown): Env {
	return { AI: { run: vi.fn(run) }, AI_GATEWAY_ID: "eleenai-gateway" } as unknown as Env;
}

function post(body: unknown, type = "application/json"): Request {
	return new Request("https://eleenai.xyz/api/voice/speak/guest", {
		method: "POST",
		headers: { "content-type": type },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0]);

describe("handleSpeak", () => {
	it("returns Aura's audio as MP3, uncached, through the gateway", async () => {
		const env = envWith(async () => new Response(MP3, { headers: { "content-type": "audio/mpeg" } }));
		const response = await handleSpeak(post({ text: "  Hello there.  " }), env);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("audio/mpeg");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3);

		const [model, input, options] = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(model).toBe("@cf/deepgram/aura-1");
		expect(input).toEqual({ text: "Hello there.", speaker: "asteria", encoding: "mp3" });
		expect(options).toMatchObject({ returnRawResponse: true, gateway: { id: "eleenai-gateway", skipCache: true } });
	});

	it("refuses a body that is not JSON before any model call", async () => {
		const env = envWith(async () => new Response(MP3));
		const response = await handleSpeak(post("hello", "text/plain"), env);
		expect(response.status).toBe(415);
		expect(env.AI.run).not.toHaveBeenCalled();
	});

	it("refuses empty, missing and overlong text before any model call", async () => {
		const env = envWith(async () => new Response(MP3));
		for (const body of [{}, { text: "   " }, { text: 42 }, { text: "a".repeat(MAX_SPEAK_CHARS + 1) }]) {
			expect((await handleSpeak(post(body), env)).status).toBe(422);
		}
		expect((await handleSpeak(post("{not json"), env)).status).toBe(400);
		expect(env.AI.run).not.toHaveBeenCalled();
	});

	it("answers 502, not a stack trace, when Aura fails", async () => {
		for (const run of [
			async () => {
				throw new Error("upstream exploded");
			},
			async () => new Response("nope", { status: 500 }),
			async () => ({ unexpected: true }),
		]) {
			const response = await handleSpeak(post({ text: "Hi" }), envWith(run));
			expect(response.status).toBe(502);
			expect(await response.text()).not.toContain("exploded");
		}
	});
});
