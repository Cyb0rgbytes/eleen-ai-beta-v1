/**
 * The outbound chat stream: provider bytes in, client SSE out, screened.
 *
 * Replaces the `filterSseStream` that lived in index.ts and understood one
 * provider shape and one output format. This one is built from three parts
 * the caller chooses:
 *
 *   - a ChunkParser for the provider's framing (src/ai/parse.ts)
 *   - an SseEncoder for the protocol the client asked for (src/ai/sse.ts)
 *   - the output filter from the guard, one instance for visible text and a
 *     second for reasoning, because a canary or an infrastructure term can
 *     leak through a model's thinking just as easily as through its answer
 *
 * With the v1 encoder and a Workers AI parser the bytes produced are identical
 * to what the old function produced; test/stream.test.ts holds a copy of the
 * old implementation and checks that.
 *
 * Nothing reaches the client until it has passed the filter. If anything is
 * blocked the stream is cut and replaced with a refusal, never truncated
 * silently.
 */
import { createOutputFilter, refusalResponse } from "./guard";
import { ChunkParser, ModelEvent } from "./parse";
import { SseEncoder } from "./sse";

export interface StreamOptions {
	canary: string;
	parser: ChunkParser;
	encoder: SseEncoder;
	/** Fields for the v2 `meta` event, sent first. Ignored by v1. */
	meta?: Record<string, unknown>;
	/**
	 * Sees exactly what passed the filter, as it is sent: how a saved turn
	 * records the reply (src/chat/saved.ts). It never changes the bytes.
	 */
	observer?: StreamObserver;
}

export interface StreamObserver {
	text(safe: string): void;
	reasoning(safe: string): void;
	usage(fields: { promptTokens?: number; completionTokens?: number }): void;
	/** The output was cut and replaced with a refusal. */
	blocked(): void;
}

export function filterModelStream(
	source: ReadableStream<Uint8Array>,
	options: StreamOptions,
): ReadableStream<Uint8Array> {
	const { parser, encoder, observer } = options;
	const textFilter = createOutputFilter(options.canary);
	const reasoningFilter = createOutputFilter(options.canary);
	const decoder = new TextDecoder();
	const textEncoder = new TextEncoder();

	let buffered = "";
	let blocked = false;
	let started = false;

	function send(controller: TransformStreamDefaultController<Uint8Array>, frame: string) {
		if (frame) controller.enqueue(textEncoder.encode(frame));
	}

	function block(controller: TransformStreamDefaultController<Uint8Array>, reason: string | undefined) {
		blocked = true;
		observer?.blocked();
		console.error("Blocked model output", { reason });
		send(controller, encoder.error(refusalResponse()));
		send(controller, encoder.done());
	}

	/** Route one event through its filter and out. Returns false once blocked. */
	function emit(controller: TransformStreamDefaultController<Uint8Array>, event: ModelEvent): boolean {
		if (event.type === "reasoning") {
			const safe = reasoningFilter.push(event.text);
			if (safe === null) {
				block(controller, reasoningFilter.reason);
				return false;
			}
			if (safe) observer?.reasoning(safe);
			send(controller, encoder.reasoning(safe));
			return true;
		}

		const safe = textFilter.push(event.text);
		if (safe === null) {
			block(controller, textFilter.reason);
			return false;
		}
		if (safe) observer?.text(safe);
		send(controller, encoder.token(safe));
		return true;
	}

	const transform = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			if (!started) {
				started = true;
				send(controller, encoder.meta(options.meta ?? {}));
			}
		},

		transform(chunk, controller) {
			if (blocked) return;

			buffered += decoder.decode(chunk, { stream: true });
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;

				const payload = trimmed.slice(5).trim();
				if (payload === "[DONE]") continue;
				if (!payload) continue;

				let parsed: unknown;
				try {
					parsed = JSON.parse(payload);
				} catch {
					continue;
				}

				for (const event of parser.parse(parsed)) {
					if (!emit(controller, event)) return;
				}
			}
		},

		flush(controller) {
			if (blocked) return;

			for (const event of parser.flush()) {
				if (!emit(controller, event)) return;
			}

			const reasoningTail = reasoningFilter.flush();
			if (reasoningTail) {
				observer?.reasoning(reasoningTail);
				send(controller, encoder.reasoning(reasoningTail));
			}

			const textTail = textFilter.flush();
			if (textTail) {
				observer?.text(textTail);
				send(controller, encoder.token(textTail));
			}

			const usage = parser.usage();
			if (usage) {
				observer?.usage(usage);
				send(controller, encoder.usage({ ...usage }));
			}

			send(controller, encoder.done());
		},
	});

	return source.pipeThrough(transform);
}

/** A complete stream that carries only a refusal, in the client's protocol. */
export function refusalStream(encoder: SseEncoder, message: string): string {
	return encoder.meta({}) + encoder.error(message) + encoder.done();
}
