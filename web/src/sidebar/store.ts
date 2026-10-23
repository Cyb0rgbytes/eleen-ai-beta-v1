/**
 * The sidebar's grouping rules, as pure functions (M4.4).
 *
 * Every chat shows exactly once:
 * - Pinned: every pinned chat, whatever folder it is filed in.
 * - A folder: its chats that are not pinned.
 * - Recent: the rest, chats that are neither pinned nor filed. A chat filed
 *   in a folder the sidebar does not know (deleted elsewhere) counts as
 *   Recent, so it never disappears.
 *
 * Each group is most recently updated first, as the server orders a page.
 */
import type { ConversationSummary, Folder } from "../../../src/shared/history";

export interface Sections {
	pinned: ConversationSummary[];
	recent: ConversationSummary[];
	/** Every known folder has an entry, empty or not. */
	byFolder: Map<string, ConversationSummary[]>;
}

export function byRecency(a: ConversationSummary, b: ConversationSummary): number {
	return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function groupConversations(conversations: Iterable<ConversationSummary>, folders: readonly Folder[]): Sections {
	const byFolder = new Map<string, ConversationSummary[]>(folders.map((f) => [f.id, []]));
	const pinned: ConversationSummary[] = [];
	const recent: ConversationSummary[] = [];
	for (const c of conversations) {
		const folder = c.folderId ? byFolder.get(c.folderId) : undefined;
		if (c.pinned) pinned.push(c);
		else if (folder) folder.push(c);
		else recent.push(c);
	}
	pinned.sort(byRecency);
	recent.sort(byRecency);
	for (const list of byFolder.values()) list.sort(byRecency);
	return { pinned, recent, byFolder };
}

/** Folders in the server's order: position, then name. */
export function sortFolders(folders: readonly Folder[]): Folder[] {
	return [...folders].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** A title as the sidebar shows it: trimmed, at most 200 characters. */
export function cleanTitle(value: string): string {
	return value.trim().slice(0, 200);
}
