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
}

export interface TextPayload {
	text: string;
}

export interface UsagePayload {
	promptTokens?: number;
	completionTokens?: number;
}

export interface ErrorPayload {
	message: string;
}

export type StreamEvent =
	| { type: "meta"; data: MetaPayload }
	| { type: "reasoning"; data: TextPayload }
	| { type: "token"; data: TextPayload }
	| { type: "usage"; data: UsagePayload }
	| { type: "error"; data: ErrorPayload }
	| { type: "done"; data: Record<string, never> };

export type StreamEventName = StreamEvent["type"];

export const STREAM_EVENT_NAMES: readonly StreamEventName[] = [
	"meta",
	"reasoning",
	"token",
	"usage",
	"error",
	"done",
];
