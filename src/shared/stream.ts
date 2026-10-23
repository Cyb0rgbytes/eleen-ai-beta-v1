/**
 * The v2 chat stream, as types both ends agree on.
 *
 * src/ai/sse.ts encodes these; web/src/api/stream.ts decodes them. Each
 * event is one SSE frame, `event: <name>` then `data: <json>`.
 */
import type { ModelTier } from "./models";

export type Protocol = 1 | 2;

export interface MetaPayload {
	model?: string;
	tier?: ModelTier;
	protocol: 2;
	/**
	 * Present only when the turn is being saved (signed in, history on): the
	 * ids the server minted, so the client can address the conversation and
	 * the new messages without a second request. See SavedTurnMeta.
	 */
	conversationId?: string;
	/** Absent on a regenerate, which adds no user turn. */
	userMessageId?: string;
	assistantMessageId?: string;
	/** Compare (M5.4), saved: the id every lane's reply shares. */
	compareGroup?: string;
	lane?: number;
	/**
	 * S2: the turn carried text from outside the conversation (an uploaded
	 * file or image) or was hardened as a likely injection, so the reply may
	 * have been steered by someone other than the user. The client then asks
	 * before acting on anything in it, such as an [IMG_GEN] request. Sent
	 * only when true.
	 */
	contained?: true;
}

/**
 * Compare (M5.4): a request with `compare: [a, b, c?]` gets one stream that
 * multiplexes 2 or 3 replies. Every event then carries `lane`, the index of
 * its model in `compare`; each lane has its own meta, tokens, usage, error
 * and `done`, and the stream ends with one `done` without a lane. Without
 * `compare` no event carries `lane`, so the stream is byte-identical to before.
 */
export interface Laned {
	lane?: number;
}

/** Most lanes a compare request may ask for. */
export const MAX_COMPARE_LANES = 3;

export interface TextPayload extends Laned {
	text: string;
}

export interface UsagePayload extends Laned {
	promptTokens?: number;
	completionTokens?: number;
}

export interface ErrorPayload extends Laned {
	message: string;
}

export type StreamEvent =
	| { type: "meta"; data: MetaPayload }
	| { type: "reasoning"; data: TextPayload }
	| { type: "token"; data: TextPayload }
	| { type: "usage"; data: UsagePayload }
	| { type: "error"; data: ErrorPayload }
	| { type: "done"; data: Laned };

export type StreamEventName = StreamEvent["type"];

export const STREAM_EVENT_NAMES: readonly StreamEventName[] = [
	"meta",
	"reasoning",
	"token",
	"usage",
	"error",
	"done",
];
