/**
 * Where an export's messages come from (M5.3).
 *
 * - A saved chat (open or picked in the sidebar): GET the conversation, so
 *   the title is the server's (auto-titles included) and the tree is whole.
 *   The visible thread is the path to the active leaf, as on screen. If the
 *   fetch fails for the open chat, the tree the page already holds is used.
 * - A guest or history-off chat: the page's own history, minus the
 *   greeting it opens with and the rating notes folded into rated replies.
 *   That history is bounded to the last 20 turns (controller.ts), so a very
 *   long unsaved chat exports its recent turns.
 */
import type { ChatMessage } from "../../../src/shared/chat";
import type { StoredMessage } from "../../../src/shared/history";
import { getConversation } from "../history/api";
import { getHistoryState } from "../history/state";
import { buildTree, defaultLeaf, pathTo } from "../history/tree";
import type { ExportConversation, ExportMessage } from "./format";

const TITLE_CHARS = 60;
const RATING = /\n\n\[User rated this response as: (Good|Bad)\]$/;

/** The title a chat has before the server names it: its first user line. */
export function fallbackTitle(messages: readonly ExportMessage[]): string {
	const first = messages.find((m) => m.role === "user")?.content ?? "";
	const line = first.replace(/\s+/g, " ").trim();
	return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
}

/** A client-history chat, as ChatApi.history() returns it. */
export function fromClientHistory(history: readonly ChatMessage[], greeting: string): ExportConversation {
	const turns = history.filter((m, i) => !(i === 0 && m.role === "assistant" && m.content === greeting));
	const messages = turns
		.filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role === "user" || m.role === "assistant")
		.map((m) => ({ role: m.role, content: m.role === "assistant" ? m.content.replace(RATING, "") : m.content }));
	return { title: fallbackTitle(messages), messages };
}

/** A saved chat's tree, on the branch ending at activeLeafId. */
export function fromTree(title: string, all: readonly StoredMessage[], activeLeafId: string | null): ExportConversation {
	const tree = buildTree(all);
	const leaf = activeLeafId && tree.byId.has(activeLeafId) ? activeLeafId : defaultLeaf(tree);
	const toExport = (m: StoredMessage): ExportMessage => ({
		role: m.role,
		content: m.content,
		model: m.role === "assistant" ? m.model : null,
		createdAt: m.createdAt,
	});
	const messages = pathTo(tree, leaf).map(toExport);
	return {
		title: title.trim() || fallbackTitle(messages),
		messages,
		tree: {
			activeLeafId: leaf,
			messages: [...all]
				.sort((a, b) => a.seq - b.seq)
				.map((m) => ({ ...toExport(m), id: m.id, parentId: m.parentId, status: m.status })),
		},
	};
}

/**
 * A saved chat from the server. `leafId` overrides the stored branch: the
 * open chat exports the branch on screen even before a switch is saved.
 */
export async function savedConversation(conversationId: string, leafId?: string | null): Promise<ExportConversation> {
	const detail = await getConversation(conversationId);
	return fromTree(detail.conversation.title, detail.messages, leafId ?? detail.conversation.activeLeafId);
}

/** The chat on screen, or null when there is nothing to export yet. */
export async function currentConversation(
	history: () => readonly ChatMessage[],
	greeting: string,
): Promise<ExportConversation | null> {
	const state = getHistoryState();
	let conversation: ExportConversation;
	if (state.conversationId) {
		try {
			conversation = await savedConversation(state.conversationId, state.activeLeafId);
		} catch {
			conversation = fromTree("", state.messages, state.activeLeafId);
		}
	} else {
		conversation = fromClientHistory(history(), greeting);
	}
	return conversation.messages.length ? conversation : null;
}
