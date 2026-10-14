import { describe, expect, it, vi } from "vitest";
import { MAX_AUDIO_BYTES, detectAudioFormat, handleTranscribe } from "../src/ai/voice";
import type { Env } from "../src/types";

const bytes = (...values: (number | string)[]) =>
	new Uint8Array(
		values.flatMap((v) => (typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : [v])),
	);

const SAMPLES = {
	webm: bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0),
	ogg: bytes("OggS", 0, 2),
	mp4: bytes(0, 0, 0, 0x20, "ftypM4A "),
	wav: bytes("RIFF", 0, 0, 0, 0, "WAVEfmt "),
	mp3: bytes("ID3", 4, 0),
};

describe("detectAudioFormat", () => {
	for (const [format, sample] of Object.entries(SAMPLES)) {
		it(`recognises ${format}`, () => {
			expect(detectAudioFormat(sample)).toBe(format);
		});
	}

	it("rejects things that are not audio", () => {
		for (const sample of [
			bytes("<!DOCTYPE html>"),
			bytes("%PDF-1.7"),
			bytes(0x89, "PNG"),
			bytes("RIFF", 0, 0, 0, 0, "AVI "),
			new Uint8Array(),
		]) {
			expect(detectAudioFormat(sample)).toBeNull();
		}
	});
});

function envWith(run: (...args: unknown[]) => unknown): Env {
	return { AI: { run: vi.fn(run) } } as unknown as Env;
}

function post(body: Uint8Array, query = ""): Request {
	return new Request(`https://eleenai.xyz/api/voice/transcribe/guest${query}`, {
		method: "POST",
		headers: { "content-type": "audio/webm" },
		body,
	});
}

describe("handleTranscribe", () => {
	it("returns the trimmed transcript and detected language", async () => {
		const env = envWith(async () => ({ text: "  hello there  ", transcription_info: { language: "en" } }));
		const response = await handleTranscribe(post(SAMPLES.webm), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: "hello there", language: "en" });
	});

	it("passes only allowlisted language hints to the model", async () => {
		const env = envWith(async () => ({ text: "مرحبا" }));
		await handleTranscribe(post(SAMPLES.webm, "?lang=ar"), env);
		await handleTranscribe(post(SAMPLES.webm, "?lang=xx"), env);
		const calls = (env.AI.run as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][1]).toMatchObject({ language: "ar" });
		expect(calls[1][1]).not.toHaveProperty("language");
	});

	it("refuses non-audio before spending inference", async () => {
		const env = envWith(async () => ({ text: "x" }));
		const response = await handleTranscribe(post(bytes("<html><script>")), env);
		expect(response.status).toBe(415);
		expect(env.AI.run).not.toHaveBeenCalled();
	});

	it("refuses empty and oversized recordings", async () => {
		const env = envWith(async () => ({ text: "x" }));
		expect((await handleTranscribe(post(new Uint8Array()), env)).status).toBe(422);

		const big = new Uint8Array(MAX_AUDIO_BYTES + 1);
		big.set(SAMPLES.webm);
		expect((await handleTranscribe(post(big), env)).status).toBe(413);
		expect(env.AI.run).not.toHaveBeenCalled();
	});

	it("reports a model failure without leaking it", async () => {
		const env = envWith(async () => {
			throw new Error("internal model detail");
		});
		const response = await handleTranscribe(post(SAMPLES.ogg), env);
		expect(response.status).toBe(502);
		expect(JSON.stringify(await response.json())).not.toContain("internal model detail");
	});
});
