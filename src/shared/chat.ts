/**
 * Chat request types shared by the Worker and the browser.
 *
 * Everything under src/shared/ must stay free of Worker types (no Env, Ai,
 * D1Database, ExecutionContext) so web/ can import it with a DOM-only
 * tsconfig. The Worker re-exports these from src/types.ts.
 */
import type { ModelTier } from "./models";
import type { Protocol } from "./stream";
import type { SavedTurnRequest } from "./history";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** A file attached to a chat message. */
export interface Attachment {
	/** Base64-encoded file data. */
	data: string;
	/** MIME type, e.g. "image/png". validate.ts holds the allowlist. */
	mimeType: string;
	/** Original filename, sanitised server-side. */
	name: string;
}

export type ResponseMode = "balanced" | "creative" | "logical";

/** POST body for /api/chat and /api/chat/guest. */
export interface ChatRequestBody {
	messages: ChatMessage[];
	attachments?: Attachment[];
	/** Response mode selected in the UI. Unknown values fall back to balanced. */
	mode?: ResponseMode | string;
	/** A registry model id or a tier name. Absent means the default model. */
	model?: ModelTier | string;
	/** Stream encoding. Absent means v1. */
	protocol?: Protocol;
	/** The user asked by voice: the reply is kept short and speakable. */
	voice?: boolean;
	/**
	 * Saved chat (protocol 2, signed in, history on); see SavedTurnRequest in
	 * history.ts. Ignored otherwise. With replyTo, messages may be empty.
	 */
	conversationId?: SavedTurnRequest["conversationId"];
	parentId?: SavedTurnRequest["parentId"];
	replyTo?: SavedTurnRequest["replyTo"];
	/**
	 * Compare (M5.4): 2 or 3 distinct model ids or tier names, answered side
	 * by side on one stream whose events carry `lane` (see stream.ts).
	 * Signed-in only, protocol 2 only, and not combined with `model`.
	 */
	compare?: string[];
}

/** 403 body when the requested model is not available to this caller. */
export interface ModelForbiddenBody {
	error: string;
	model: string;
	reason: "sign-in" | "key-required";
}
