/**
 * Provider chunk parsing.
 *
 * Every provider streams something different. Workers AI's native models send
 * `{"response": "…"}`; OpenAI-compatible providers (and newer Workers AI
 * models) send `{"choices":[{"delta":{"content":"…","reasoning_content":"…"}}]}`;
 * DeepSeek R1 distills put their reasoning inline as `<think>…</think>` text.
 * Before this module the stream filter read only `.response`, so a model using
 * either of the other shapes came back silently empty.
 *
 * The parser turns any of those into a flat list of events, each either
 * visible text or reasoning, so everything downstream — the output filter, the
 * SSE encoders — is provider-neutral.
 */
import { ReasoningFormat } from "./registry";

export interface ModelEvent {
	type: "text" | "reasoning";
	text: string;
}

/** The fields any supported provider might put in one chunk. */
interface RawChunk {
	response?: unknown;
	choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>;
	/** Workers AI usage block, present on the final chunk of some models. */
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface ParsedUsage {
	promptTokens?: number;
	completionTokens?: number;
}

export interface ChunkParser {
	/** Events from one decoded JSON payload. */
	parse(payload: unknown): ModelEvent[];
	/** Anything still held back at end of stream. */
	flush(): ModelEvent[];
	/** Token counts, if the provider reported them. */
	usage(): ParsedUsage | null;
}

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * Split `<think>` blocks out of a text stream that may cut a tag anywhere.
 *
 * Holds back any trailing partial tag ("<thi", "</th") until the next chunk
 * shows whether it completes, so a tag split across chunks is still caught
 * and ordinary text containing "<" is passed through once it is clear it is
 * not a tag.
 */
function createThinkSplitter() {
	let inThink = false;
	let pending = "";

	function isTagPrefix(s: string): boolean {
		return OPEN.startsWith(s) || CLOSE.startsWith(s);
	}

	return {
		push(text: string): ModelEvent[] {
			const events: ModelEvent[] = [];
			let buf = pending + text;
			pending = "";

			while (buf.length > 0) {
				const tag = inThink ? CLOSE : OPEN;
				const at = buf.indexOf(tag);

				if (at >= 0) {
					const before = buf.slice(0, at);
					if (before) events.push({ type: inThink ? "reasoning" : "text", text: before });
					inThink = !inThink;
					buf = buf.slice(at + tag.length);
					continue;
				}

				// No complete tag. Hold back a tail that could be the start of one.
				let hold = 0;
				for (let n = Math.min(tag.length - 1, buf.length); n > 0; n--) {
					const tail = buf.slice(buf.length - n);
					if (isTagPrefix(tail)) {
						hold = n;
						break;
					}
				}
				const emit = buf.slice(0, buf.length - hold);
				pending = buf.slice(buf.length - hold);
				if (emit) events.push({ type: inThink ? "reasoning" : "text", text: emit });
				buf = "";
			}

			return events;
		},
		flush(): ModelEvent[] {
			if (!pending) return [];
			const out: ModelEvent[] = [{ type: inThink ? "reasoning" : "text", text: pending }];
			pending = "";
			return out;
		},
	};
}

export function createChunkParser(format: ReasoningFormat): ChunkParser {
	const splitter = format === "think-tags" ? createThinkSplitter() : null;
	let usage: ParsedUsage | null = null;

	function text(value: unknown): string {
		return typeof value === "string" ? value : "";
	}

	return {
		parse(payload: unknown): ModelEvent[] {
			if (!payload || typeof payload !== "object") return [];
			const chunk = payload as RawChunk;
			const events: ModelEvent[] = [];

			if (chunk.usage && typeof chunk.usage === "object") {
				usage = {
					promptTokens: chunk.usage.prompt_tokens,
					completionTokens: chunk.usage.completion_tokens,
				};
			}

			let content = text(chunk.response);
			let reasoning = "";

			const delta = chunk.choices?.[0]?.delta;
			if (delta) {
				content = content || text(delta.content);
				reasoning = text(delta.reasoning_content) || text(delta.reasoning);
			}

			if (reasoning) events.push({ type: "reasoning", text: reasoning });

			if (content) {
				if (splitter) events.push(...splitter.push(content));
				else events.push({ type: "text", text: content });
			}

			return events;
		},
		flush(): ModelEvent[] {
			return splitter ? splitter.flush() : [];
		},
		usage(): ParsedUsage | null {
			return usage;
		},
	};
}
