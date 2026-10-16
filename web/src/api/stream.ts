/**
 * Reads the chat endpoint's SSE body into typed events.
 *
 * The page always asks for protocol 2 (named events: meta, reasoning,
 * token, usage, error, done). A v1 body, `data: {"response":…}` ending in
 * `data: [DONE]`, is still understood and mapped onto the same events, so
 * an older Worker or a cached response cannot leave the reply blank.
 *
 * Frames can split anywhere across network chunks; nothing is emitted until
 * a frame's terminating blank line arrives. Unknown event names and
 * malformed JSON are skipped rather than thrown, because one bad frame
 * should not cost the rest of the reply.
 */
import type { StreamEvent, StreamEventName } from "../../../src/shared/stream";
import { STREAM_EVENT_NAMES } from "../../../src/shared/stream";

export type { StreamEvent } from "../../../src/shared/stream";

const KNOWN = new Set<string>(STREAM_EVENT_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turn one complete frame (its event and data lines) into an event. */
export function parseFrame(eventName: string | null, data: string): StreamEvent | null {
	if (data === "[DONE]") return { type: "done", data: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;

	// v1: no event line, a `response` string.
	if (eventName === null) {
		return typeof parsed.response === "string" ? { type: "token", data: { text: parsed.response } } : null;
	}

	if (!KNOWN.has(eventName)) return null;
	const name = eventName as StreamEventName;

	switch (name) {
		case "token":
		case "reasoning":
			return typeof parsed.text === "string" ? { type: name, data: { text: parsed.text } } : null;
		case "error":
			return typeof parsed.message === "string" ? { type: "error", data: { message: parsed.message } } : null;
		case "usage":
			return {
				type: "usage",
				data: {
					...(typeof parsed.promptTokens === "number" ? { promptTokens: parsed.promptTokens } : {}),
					...(typeof parsed.completionTokens === "number" ? { completionTokens: parsed.completionTokens } : {}),
				},
			};
		case "meta":
			return {
				type: "meta",
				data: {
					protocol: 2,
					...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
					...(parsed.tier === "fast" || parsed.tier === "smart" || parsed.tier === "reasoning"
						? { tier: parsed.tier }
						: {}),
				},
			};
		case "done":
			return { type: "done", data: {} };
	}
}

/**
 * Yield events from an SSE body until it ends, a `done` arrives, or the
 * signal aborts. Aborting cancels the underlying reader, which closes the
 * connection so the Worker stops generating.
 */
export async function* readEvents(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, undefined> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName: string | null = null;
	let dataLines: string[] = [];

	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		for (;;) {
			if (signal?.aborted) return;
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);

				if (line === "") {
					// End of a frame.
					if (dataLines.length) {
						const event = parseFrame(eventName, dataLines.join("\n"));
						if (event) {
							yield event;
							if (event.type === "done") return;
						}
					}
					eventName = null;
					dataLines = [];
					continue;
				}
				if (line.startsWith(":")) continue; // comment / keep-alive
				if (line.startsWith("event:")) {
					eventName = line.slice(6).trim();
				} else if (line.startsWith("data:")) {
					dataLines.push(line.slice(5).replace(/^ /, ""));
				}
			}
		}
		// A body that ends without a trailing blank line still has a frame.
		if (dataLines.length) {
			const event = parseFrame(eventName, dataLines.join("\n"));
			if (event) yield event;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}
