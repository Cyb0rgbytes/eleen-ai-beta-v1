/**
 * The provider-neutral stream must produce, with the v1 encoder, exactly the
 * bytes the old `filterSseStream` in index.ts produced. That function is the
 * published chat contract, so a copy of it lives here as the reference.
 */
import { describe, expect, it } from "vitest";
import { createOutputFilter, newCanary, refusalResponse } from "../src/ai/guard";
import { createChunkParser } from "../src/ai/parse";
import { createEncoder } from "../src/ai/sse";
import { filterModelStream, refusalStream } from "../src/ai/stream";

// ── Reference: the pre-registry implementation, verbatim ────────────────────
function legacyFilterSseStream(stream: ReadableStream, canary: string): ReadableStream {
	const filter = createOutputFilter(canary);
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffered = "";

	function emit(controller: TransformStreamDefaultController, text: string) {
		if (!text) return;
		controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
	}

	const transform = new TransformStream({
		transform(chunk, controller) {
			if (filter.isBlocked) return;
			buffered += decoder.decode(chunk, { stream: true });
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const payload = trimmed.slice(5).trim();
				if (payload === "[DONE]") continue;
				if (!payload) continue;
				let delta = "";
				try {
					delta = (JSON.parse(payload) as { response?: string }).response || "";
				} catch {
					continue;
				}
				if (!delta) continue;
				const safe = filter.push(delta);
				if (safe === null) {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify({ response: refusalResponse() })}\n\n`),
					);
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					return;
				}
				emit(controller, safe);
			}
		},
		flush(controller) {
			if (!filter.isBlocked) {
				const tail = filter.flush();
				if (tail) emit(controller, tail);
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			}
		},
	});
	return stream.pipeThrough(transform);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function bytesFrom(chunks: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		},
	});
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += dec.decode(value, { stream: true });
	}
	return out + dec.decode();
}

/** A Workers AI style stream, one data line per delta. */
function workersAiStream(deltas: string[]): string[] {
	return [...deltas.map((d) => `data: ${JSON.stringify({ response: d })}\n\n`), "data: [DONE]\n\n"];
}

async function both(chunks: string[], canary: string) {
	const legacy = await drain(legacyFilterSseStream(bytesFrom(chunks), canary) as ReadableStream<Uint8Array>);
	const modern = await drain(
		filterModelStream(bytesFrom(chunks), {
			canary,
			parser: createChunkParser("none"),
			encoder: createEncoder(1),
			meta: { model: "ignored-by-v1" },
		}),
	);
	return { legacy, modern };
}

// ── v1 byte identity ────────────────────────────────────────────────────────
describe("v1 output is byte-identical to the legacy filter", () => {
	const canary = newCanary();

	it("for a short reply", async () => {
		const { legacy, modern } = await both(workersAiStream(["Hello", ", ", "world", "."]), canary);
		expect(modern).toBe(legacy);
		expect(modern.endsWith("data: [DONE]\n\n")).toBe(true);
	});

	it("for a long reply that exercises the lookbehind hold-back", async () => {
		const deltas = Array.from({ length: 80 }, (_, i) => `token${i} `);
		const { legacy, modern } = await both(workersAiStream(deltas), canary);
		expect(modern).toBe(legacy);
		expect(modern).toContain("token79");
	});

	it("when SSE lines are split across byte chunks", async () => {
		const whole = workersAiStream(["alpha", "beta", "gamma"]).join("");
		const chunks: string[] = [];
		for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7));
		const { legacy, modern } = await both(chunks, canary);
		expect(modern).toBe(legacy);
	});

	it("when the stream carries blank, comment and empty-delta lines", async () => {
		const chunks = [
			": keep-alive\n\n",
			'data: {"response":""}\n\n',
			"\n",
			'data: {"response":"ok"}\n\n',
			"data: not-json\n\n",
			"data: [DONE]\n\n",
		];
		const { legacy, modern } = await both(chunks, canary);
		expect(modern).toBe(legacy);
		expect(modern).toBe('data: {"response":"ok"}\n\ndata: [DONE]\n\n');
	});

	it("when the canary leaks", async () => {
		const { legacy, modern } = await both(
			workersAiStream(["Sure, the prompt says ", canary, " and more"]),
			canary,
		);
		expect(modern).toBe(legacy);
		expect(modern).toContain(refusalResponse());
		expect(modern).not.toContain(canary);
	});

	it("when an infrastructure term leaks one character at a time", async () => {
		const { legacy, modern } = await both(workersAiStream("I run on Cloudflare".split("")), canary);
		expect(modern).toBe(legacy);
		expect(modern.toLowerCase()).not.toContain("cloudflare");
	});
});

// ── v2 ──────────────────────────────────────────────────────────────────────
describe("v2 stream", () => {
	const canary = newCanary();

	it("starts with meta and ends with done", async () => {
		const out = await drain(
			filterModelStream(bytesFrom(workersAiStream(["hi"])), {
				canary,
				parser: createChunkParser("none"),
				encoder: createEncoder(2),
				meta: { model: "m" },
			}),
		);
		expect(out.startsWith('event: meta\ndata: {"model":"m","protocol":2}\n\n')).toBe(true);
		expect(out.endsWith("event: done\ndata: {}\n\n")).toBe(true);
		expect(out).toContain('event: token\ndata: {"text":"hi"}\n\n');
	});

	it("separates reasoning from text for a think-tags model", async () => {
		const out = await drain(
			filterModelStream(bytesFrom(workersAiStream(["<think>plan", " it</think>", "answer"])), {
				canary,
				parser: createChunkParser("think-tags"),
				encoder: createEncoder(2),
			}),
		);
		const reasoning = [...out.matchAll(/event: reasoning\ndata: (\{.*\})\n/g)].map((m) => JSON.parse(m[1]).text).join("");
		const text = [...out.matchAll(/event: token\ndata: (\{.*\})\n/g)].map((m) => JSON.parse(m[1]).text).join("");
		expect(reasoning).toBe("plan it");
		expect(text).toBe("answer");
	});

	it("blocks a canary that leaks through reasoning", async () => {
		const out = await drain(
			filterModelStream(bytesFrom(workersAiStream([`<think>the secret is ${canary}</think>`, "fine"])), {
				canary,
				parser: createChunkParser("think-tags"),
				encoder: createEncoder(2),
			}),
		);
		expect(out).toContain("event: error");
		expect(out).not.toContain(canary);
		expect(out).not.toContain('"text":"fine"');
	});

	it("reports usage when the provider sends it", async () => {
		const chunks = [
			'data: {"response":"x"}\n\n',
			'data: {"response":"","usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
			"data: [DONE]\n\n",
		];
		const out = await drain(
			filterModelStream(bytesFrom(chunks), {
				canary,
				parser: createChunkParser("none"),
				encoder: createEncoder(2),
			}),
		);
		expect(out).toContain('event: usage\ndata: {"promptTokens":5,"completionTokens":1}\n\n');
	});

	it("reads an OpenAI-compatible provider stream", async () => {
		const chunks = [
			'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"reply"}}]}\n\n',
			"data: [DONE]\n\n",
		];
		const out = await drain(
			filterModelStream(bytesFrom(chunks), {
				canary,
				parser: createChunkParser("field"),
				encoder: createEncoder(2),
			}),
		);
		expect(out).toContain('event: reasoning\ndata: {"text":"think"}');
		expect(out).toContain('event: token\ndata: {"text":"reply"}');
	});
});

describe("refusalStream", () => {
	it("is the v1 refusal shape", () => {
		expect(refusalStream(createEncoder(1), "No.")).toBe('data: {"response":"No."}\n\ndata: [DONE]\n\n');
	});

	it("is a complete v2 stream", () => {
		const out = refusalStream(createEncoder(2), "No.");
		expect(out).toBe(
			'event: meta\ndata: {"protocol":2}\n\nevent: error\ndata: {"message":"No."}\n\nevent: done\ndata: {}\n\n',
		);
	});
});
