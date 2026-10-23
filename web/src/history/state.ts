/**
 * Which conversation is open and whether it is being saved, shared by the
 * chat (M4.3) and the sidebar (M4.4).
 *
 * Saved mode needs both a signed-in user and history consent. Until both are
 * known to be true the chat runs as before: from its own client history,
 * sending none of the saved-chat ids, so nothing is stored.
 *
 * Two window events let parts that never import each other keep in step:
 * - CONVERSATION_CHANGED_EVENT: another conversation (or a new, unsaved one)
 *   is now open. detail: { conversationId: string | null }.
 * - CONVERSATION_UPDATED_EVENT: one conversation's summary changed (it was
 *   created, retitled, pinned, filed, or got a new turn).
 *   detail: { conversation: ConversationSummary }.
 */
import type { ConversationSummary, StoredMessage } from "../../../src/shared/history";

export const CONVERSATION_CHANGED_EVENT = "eleen:conversation-changed";
export const CONVERSATION_UPDATED_EVENT = "eleen:conversation-updated";

export interface ConversationChangedDetail {
	conversationId: string | null;
}

export interface ConversationUpdatedDetail {
	conversation: ConversationSummary;
}

export interface HistoryState {
	signedIn: boolean;
	/** History consent: null until it has been read for this session. */
	historyOn: boolean | null;
	/** The open conversation, or null for a new chat not yet saved. */
	conversationId: string | null;
	/** The open conversation's whole tree. */
	messages: readonly StoredMessage[];
	activeLeafId: string | null;
}

const INITIAL: HistoryState = {
	signedIn: false,
	historyOn: null,
	conversationId: null,
	messages: [],
	activeLeafId: null,
};

let state: HistoryState = { ...INITIAL };
const listeners = new Set<(state: HistoryState) => void>();

export function getHistoryState(): HistoryState {
	return state;
}

/** True when a new turn should be saved: signed in and history on. */
export function isSavedMode(current: HistoryState = state): boolean {
	return current.signedIn && current.historyOn === true;
}

export function setHistoryState(patch: Partial<HistoryState>): void {
	const before = state;
	state = { ...state, ...patch };
	// Signing out, or another account, forgets what was open.
	if (before.signedIn && !state.signedIn) state = { ...INITIAL };
	for (const listener of listeners) listener(state);
	if (before.conversationId !== state.conversationId) {
		window.dispatchEvent(
			new CustomEvent<ConversationChangedDetail>(CONVERSATION_CHANGED_EVENT, {
				detail: { conversationId: state.conversationId },
			}),
		);
	}
}

export function subscribeHistory(listener: (state: HistoryState) => void): () => void {
	listeners.add(listener);
	listener(state);
	return () => listeners.delete(listener);
}

export function announceConversation(conversation: ConversationSummary): void {
	window.dispatchEvent(
		new CustomEvent<ConversationUpdatedDetail>(CONVERSATION_UPDATED_EVENT, { detail: { conversation } }),
	);
}

/** Tests only: back to a signed-out page with nothing open. */
export function resetHistoryState(): void {
	state = { ...INITIAL };
	listeners.clear();
}
