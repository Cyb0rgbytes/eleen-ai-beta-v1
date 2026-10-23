/**
 * Phase 4 API contract: conversation history, folders, search, consent and
 * memory, as types both ends agree on (migrations/0003_core.sql).
 *
 * Every route here is signed-in only and acts on the caller's own rows.
 * Times are unix milliseconds. Ids are random UUIDs minted by the server.
 *
 *   GET    /api/v1/consent                  -> ConsentResponse
 *   PUT    /api/v1/consent                  ConsentUpdate -> ConsentResponse
 *   GET    /api/v1/memory                   -> MemoryList
 *   DELETE /api/v1/memory                   -> 204, forgets every fact
 *   DELETE /api/v1/memory/:id               -> 204
 *
 *   GET    /api/v1/conversations            ?folder=<id>|none&cursor= -> ConversationList
 *   POST   /api/v1/conversations            { title? } -> { conversation: ConversationSummary }
 *   DELETE /api/v1/conversations            -> 204, deletes all of the caller's history
 *   GET    /api/v1/conversations/:id        -> ConversationDetail
 *   PATCH  /api/v1/conversations/:id        ConversationUpdate -> { conversation: ConversationSummary }
 *   DELETE /api/v1/conversations/:id        -> 204 (soft; ?purge=1 removes it for good)
 *   POST   /api/v1/conversations/:id/restore -> { conversation: ConversationSummary }, undoes a soft delete
 *
 *   GET    /api/v1/folders                  -> { folders: Folder[] }
 *   POST   /api/v1/folders                  { name } -> { folder: Folder }
 *   PATCH  /api/v1/folders/:id              { name?, position? } -> { folder: Folder }
 *   DELETE /api/v1/folders/:id              -> 204; its conversations move to no folder
 *
 *   GET    /api/v1/search?q=                -> SearchResponse
 *
 * Another user's id, or an unknown one, is always 404, never 403: the
 * answer must not reveal that the row exists.
 */

/** The privacy policy version the consent dialog asks about. Bump to ask again. */
export const POLICY_VERSION = 1;

export interface Consent {
	/** Conversations are saved to the account. Default on. */
	history: boolean;
	/** Facts about the user are remembered across conversations. Default off. */
	memory: boolean;
	policyVersion: number;
	updatedAt: number;
}

export interface ConsentResponse {
	/** null until the user has answered the dialog. Until then history is on and memory off. */
	consent: Consent | null;
	/** The current POLICY_VERSION; ask again when consent.policyVersion is lower. */
	policyVersion: number;
}

/**
 * Turning memory off forgets every stored fact. Turning history off stops
 * saving new conversations; saved ones stay until deleted.
 */
export interface ConsentUpdate {
	history: boolean;
	memory: boolean;
}

export interface MemoryEntry {
	id: string;
	fact: string;
	createdAt: number;
}

export interface MemoryList {
	entries: MemoryEntry[];
}

export interface ConversationSummary {
	id: string;
	title: string;
	pinned: boolean;
	folderId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface ConversationList {
	/** Pinned first, then most recently updated. */
	conversations: ConversationSummary[];
	nextCursor: string | null;
}

export type MessageStatus = "streaming" | "complete" | "stopped" | "error";

export interface StoredMessage {
	id: string;
	/** null for the first turn. Siblings share a parent and sort by seq. */
	parentId: string | null;
	seq: number;
	role: "user" | "assistant";
	content: string;
	reasoning: string | null;
	model: string | null;
	status: MessageStatus;
	compareGroup: string | null;
	completionTokens: number | null;
	createdAt: number;
}

export interface ConversationDetail {
	conversation: ConversationSummary & { activeLeafId: string | null };
	/** Every message in the conversation (the whole tree), ordered by seq. */
	messages: StoredMessage[];
}

export interface ConversationUpdate {
	title?: string;
	pinned?: boolean;
	folderId?: string | null;
	/** Switch the visible branch: must be a message in this conversation. */
	activeLeafId?: string;
}

export interface Folder {
	id: string;
	name: string;
	position: number;
}

export interface SearchHit {
	conversationId: string;
	messageId: string;
	title: string;
	/** Plain text around the match. Never HTML. */
	snippet: string;
	createdAt: number;
}

export interface SearchResponse {
	results: SearchHit[];
}

/**
 * Saved chat (v2 protocol, signed in, history on). Added to ChatRequestBody:
 *
 * - New turn: { conversationId?, parentId, messages: [{ role: "user", content }] }.
 *   The server ignores any client-sent history: it rebuilds the context by
 *   walking parentId up through the caller's own messages, so a client can
 *   neither forge earlier turns nor read another user's. No conversationId
 *   starts a new conversation. parentId is the message the new turn follows
 *   (null for the first); an edit is a new turn with the edited turn's parent.
 * - Regenerate: { conversationId, replyTo: <user message id>, messages: [] }:
 *   a new assistant sibling answering that turn again.
 *
 * The stream's meta event then carries SavedTurnMeta, and the reply is saved
 * as it streams, ending complete, stopped or error.
 *
 * Saving is opt-in per request: a client must send at least one of
 * conversationId, parentId (null on a first turn) or replyTo. A request with
 * none of them is answered from its own history and saves nothing, which is
 * how clients that predate saved chat keep working.
 */
export interface SavedTurnRequest {
	conversationId?: string;
	parentId?: string | null;
	replyTo?: string;
}

export interface SavedTurnMeta {
	conversationId: string;
	/** Absent on a regenerate, which adds no user turn. */
	userMessageId?: string;
	assistantMessageId: string;
}
