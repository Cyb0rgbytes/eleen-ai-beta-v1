/**
 * Compare (M5.4): two or three models answer the same turn side by side.
 *
 * One request, one response. The chat body names the models in `compare`;
 * every lane runs at once and the replies are multiplexed onto a single v2
 * stream, each event carrying its `lane` (src/shared/stream.ts). Why one
 * stream rather than a request per model from the browser:
 *
 *   - The quota is charged once, to the `compare` bucket, at a cost of one
 *     unit per model, before any model runs. N requests would each need a
 *     share of it, and could be replayed one at a time.
 *   - A saved turn is one transaction: the user message and every lane's
 *     reply row are written together, sharing a compare_group. Separate
 *     requests would each have to find, or race to create, that turn.
 *   - Stop is one abort. Cancelling the response cancels every lane, and each
 *     saves as stopped with what it had sent.
 *   - It costs one of the browser's six connections per origin, not three.
 *
 * Each lane is the ordinary single-model pipeline: provider stream, the
 * guard's output filter (filterModelStream), and for a saved turn the reply
 * recorder. A lane that fails ends with an `error` and `done` of its own;
 * the others carry on.
 */
import { Env } from "../types";
import { ChatMessage } from "../types";
import { createChunkParser } from "../ai/parse";
import { runChat } from "../ai/providers";
import { ModelSpec, outputCap } from "../ai/registry";
import { SseEncoder, createEncoder } from "../ai/sse";
import { filterModelStream } from "../ai/stream";
import { CompareTurnMeta, SavedTurnPlan, commitCompareTurn, createReplyCollector, finishSavedTurn, recordReply } from "./saved";

/** What a lane says when its model failed to start or broke off. */
export const LANE_FAILED = "This model could not finish its answer. Try again.";

const bytes = new TextEncoder();

function staticStream(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.encode(text));
			controller.close();
		},
	});
}

/** A refusal on every lane, then the stream's end: the compare form of refusalStream. */
export function compareRefusal(lanes: number, message: string): string {
	let out = "";
	for (let lane = 0; lane < lanes; lane++) {
		const encoder = createEncoder(2, { lane });
		out += encoder.meta({}) + encoder.error(message) + encoder.done();
	}
	return out + createEncoder(2).done();
}

export interface Lane {
	stream: ReadableStream<Uint8Array>;
	encoder: SseEncoder;
}

/**
 * Interleave lane streams into one body. Every chunk a lane yields is whole
 * SSE frames (filterModelStream enqueues one frame per chunk), so chunks
 * are forwarded as they are and two lanes' frames never mix.
 *
 * A lane whose stream errors gets an `error` and `done` of its own and the
 * others carry on. Once every lane has ended, a `done` without a lane ends
 * the stream. Cancelling it (the Stop button) cancels every lane.
 */
export function mergeLanes(lanes: readonly Lane[], failure = LANE_FAILED): ReadableStream<Uint8Array> {
	const readers = lanes.map((lane) => lane.stream.getReader());
	let closed = false;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>, encoder: SseEncoder) => {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) return;
						if (!closed) controller.enqueue(value);
					}
				} catch (error) {
					if (closed) return;
					console.error("Compare lane failed:", error instanceof Error ? error.message : "unknown");
					controller.enqueue(bytes.encode(encoder.error(failure) + encoder.done()));
				}
			};
			void Promise.all(readers.map((reader, i) => pump(reader, lanes[i]!.encoder))).then(() => {
				if (closed) return;
				closed = true;
				controller.enqueue(bytes.encode(createEncoder(2).done()));
				controller.close();
			});
		},
		async cancel(reason) {
			closed = true;
			await Promise.all(readers.map((reader) => reader.cancel(reason).catch(() => {})));
		},
	});
}

export interface CompareRun {
	env: Env;
	ctx: ExecutionContext;
	userId: string;
	specs: readonly ModelSpec[];
	/** The caller's provider key per lane, for user-key models. */
	userKeys: readonly (string | undefined)[];
	/** The assembled context, system prompt first. Shared, never changed. */
	messages: ChatMessage[];
	canary: string;
	maxTokens?: number;
	plan: SavedTurnPlan | null;
}

/**
 * Start every lane, save the turn if it is a saved one, and return the
 * multiplexed body. Throws only when no lane could start, so a request in
 * which every model failed is answered as a single failed request is.
 */
export async function runCompare(run: CompareRun): Promise<{ body: ReadableStream<Uint8Array>; saved: CompareTurnMeta | null }> {
	const { env, ctx, userId, specs, plan } = run;

	const started = await Promise.allSettled(
		specs.map((spec, lane) =>
			runChat(env, spec, {
				messages: run.messages,
				maxTokens: outputCap(spec, userId, run.maxTokens),
				route: "compare",
				userKey: run.userKeys[lane],
			}),
		),
	);
	const firstFailure = started.find((s): s is PromiseRejectedResult => s.status === "rejected");
	if (firstFailure && started.every((s) => s.status === "rejected")) throw firstFailure.reason;

	let saved: CompareTurnMeta | null = null;
	if (plan) {
		try {
			saved = await commitCompareTurn(env.DB, userId, plan, specs.map((spec) => spec.id));
		} catch (error) {
			await Promise.all(started.map((s) => (s.status === "fulfilled" ? s.value.stream.cancel().catch(() => {}) : undefined)));
			throw error;
		}
	}

	const lanes = specs.map((spec, lane): Lane => {
		const encoder = createEncoder(2, { lane });
		const assistantMessageId = saved?.assistantMessageIds[lane];
		const meta = {
			model: spec.id,
			tier: spec.tier,
			...(saved
				? {
						conversationId: saved.conversationId,
						...(saved.userMessageId ? { userMessageId: saved.userMessageId } : {}),
						assistantMessageId,
						compareGroup: saved.compareGroup,
					}
				: {}),
		};
		const collector = saved ? createReplyCollector() : null;
		const outcome = started[lane]!;

		let stream: ReadableStream<Uint8Array>;
		if (outcome.status === "fulfilled") {
			stream = filterModelStream(outcome.value.stream, {
				canary: run.canary,
				parser: createChunkParser(spec.reasoning),
				encoder,
				meta,
				observer: collector?.observer,
			});
		} else {
			console.error("Compare lane could not start:", spec.id, outcome.reason instanceof Error ? outcome.reason.message : "unknown");
			// Saved as error, like a reply the filter cut.
			collector?.observer.blocked();
			stream = staticStream(encoder.meta(meta) + encoder.error(LANE_FAILED) + encoder.done());
		}

		if (saved && collector && plan && assistantMessageId) {
			const ids = {
				conversationId: saved.conversationId,
				...(saved.userMessageId ? { userMessageId: saved.userMessageId } : {}),
				assistantMessageId,
			};
			const savedPlan = plan;
			stream = recordReply(stream, collector, ctx, (result) =>
				finishSavedTurn(env, userId, savedPlan, ids, result, { primary: lane === 0 }),
			);
		}
		return { stream, encoder };
	});

	return { body: mergeLanes(lanes), saved };
}
