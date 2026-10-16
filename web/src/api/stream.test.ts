/**
 * The decoder is tested against frames written by the Worker's own encoder,
 * so a change on either side that breaks the other fails here.
 */
import { describe, expect, it } from "vitest";
import { createEncoder } from "../../../src/ai/sse";
import { readEvents, parseFrame, type StreamEvent } from "./stream";

function body(chunks: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of readEvents(stream, signal)) out.push(event);
	return out;
}

const v2 = createEncoder(2);
const v1 = createEncoder(1);

describe("readEvents on v2", () => {
	const frames = [
		v2.meta({ model: "@cf/x", tier: "reasoning" }),
		v2.reasoning("thinking "),
		v2.reasoning("hard"),
		v2.token("Hello"),
		v2.token(", world"),
		v2.usage({ promptTokens: 12, completionTokens: 3 }),
		v2.done(),
	].join("");

	const expected: StreamEvent[] = [
		{ type: "meta", data: { protocol: 2, model: "@cf/x", tier: "reasoning" } },
		{ type: "reasoning", data: { text: "thinking " } },
		{ type: "reasoning", data: { text: "hard" } },
		{ type: "token", data: { text: "Hello" } },
		{ type: "token", data: { text: ", world" } },
		{ type: "usage", data: { promptTokens: 12, completionTokens: 3 } },
		{ type: "done", data: {} },
	];

	it("decodes every event the encoder writes", async () => {
		expect(await collect(body([frames]))).toEqual(expected);
	});

	it("is unaffected by where the network splits the bytes", async () => {
		for (const size of [1, 2, 3, 7, 13, 64]) {
			const chunks: string[] = [];
			for (let i = 0; i < frames.length; i += size) chunks.push(frames.slice(i, i + size));
			expect(await collect(body(chunks)), `chunk size ${size}`).toEqual(expected);
		}
	});

	it("carries an error event", async () => {
		const out = await collect(body([v2.meta({}), v2.error("Refused."), v2.done()]));
		expect(out[1]).toEqual({ type: "error", data: { message: "Refused." } });
	});

	it("stops at done even if bytes follow", async () => {
		const out = await collect(body([v2.token("a"), v2.done(), v2.token("after")]));
		expect(out.map((e) => e.type)).toEqual(["token", "done"]);
	});

	it("handles CRLF line endings", async () => {
		const out = await collect(body([v2.token("x").replace(/\n/g, "\r\n")]));
		expect(out).toEqual([{ type: "token", data: { text: "x" } }]);
	});
});

describe("readEvents on v1", () => {
	it("maps the published framing onto token and done", async () => {
		const out = await collect(body([v1.token("TLS"), v1.token(" session"), v1.done()]));
		expect(out).toEqual([
			{ type: "token", data: { text: "TLS" } },
			{ type: "token", data: { text: " session" } },
			{ type: "done", data: {} },
		]);
	});
});

describe("robustness", () => {
	it("skips comments, malformed JSON and unknown events", async () => {
		const out = await collect(
			body([
				": keep-alive\n\n",
				"event: token\ndata: not json\n\n",
				'event: surprise\ndata: {"text":"x"}\n\n',
				'event: token\ndata: {"wrong":1}\n\n',
				v2.token("ok"),
			]),
		);
		expect(out).toEqual([{ type: "token", data: { text: "ok" } }]);
	});

	it("keeps only the fields a payload is allowed to carry", () => {
		expect(parseFrame("token", '{"text":"a","html":"<b>"}')).toEqual({ type: "token", data: { text: "a" } });
		expect(parseFrame("meta", '{"tier":"evil","model":"m"}')).toEqual({
			type: "meta",
			data: { protocol: 2, model: "m" },
		});
	});

	it("stops reading when aborted", async () => {
		const controller = new AbortController();
		const enc = new TextEncoder();
		let pulls = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(c) {
				pulls++;
				c.enqueue(enc.encode(v2.token(`t${pulls}`)));
			},
		});
		const out: StreamEvent[] = [];
		for await (const event of readEvents(endless, controller.signal)) {
			out.push(event);
			if (out.length === 3) controller.abort();
		}
		expect(out).toHaveLength(3);
	});
});
