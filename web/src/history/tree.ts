/**
 * A saved conversation's message tree, as pure functions over the flat
 * StoredMessage[] the server sends (GET /api/v1/conversations/:id).
 *
 * Siblings share a parentId (null for first turns) and sort by seq. The
 * visible thread is the path from the root down to the active leaf; a
 * branch switch picks a sibling and follows it down to its newest leaf.
 */
import type { StoredMessage } from "../../../src/shared/history";

export interface Tree {
	byId: Map<string, StoredMessage>;
	/** parentId (or "" for roots) to children sorted by seq. */
	children: Map<string, StoredMessage[]>;
}

const ROOT = "";

export function buildTree(messages: readonly StoredMessage[]): Tree {
	const byId = new Map<string, StoredMessage>();
	const children = new Map<string, StoredMessage[]>();
	for (const message of messages) {
		byId.set(message.id, message);
		const key = message.parentId ?? ROOT;
		const group = children.get(key);
		if (group) group.push(message);
		else children.set(key, [message]);
	}
	for (const group of children.values()) group.sort((a, b) => a.seq - b.seq);
	return { byId, children };
}

/** The children of a message, or the first turns for null. */
export function childrenOf(tree: Tree, parentId: string | null): StoredMessage[] {
	return tree.children.get(parentId ?? ROOT) ?? [];
}

/**
 * Root to leafId, inclusive. Stops early at a missing parent or a cycle, so
 * a tree the server sent half of still renders what it has.
 */
export function pathTo(tree: Tree, leafId: string | null): StoredMessage[] {
	const path: StoredMessage[] = [];
	const seen = new Set<string>();
	let current = leafId ? tree.byId.get(leafId) : undefined;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? tree.byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

/** Follow the newest (highest seq) child down from id to a leaf. */
export function deepestLeaf(tree: Tree, id: string): string {
	const seen = new Set<string>([id]);
	let current = id;
	for (;;) {
		const next = childrenOf(tree, current).at(-1);
		if (!next || seen.has(next.id)) return current;
		seen.add(next.id);
		current = next.id;
	}
}

/** The leaf to show when nothing says otherwise: the newest branch from the newest root. */
export function defaultLeaf(tree: Tree): string | null {
	const root = childrenOf(tree, null).at(-1);
	return root ? deepestLeaf(tree, root.id) : null;
}

export interface SiblingInfo {
	/** 1-based position among its siblings, for "2 of 3". */
	index: number;
	count: number;
	prevId: string | null;
	nextId: string | null;
}

export function siblingInfo(tree: Tree, id: string): SiblingInfo | null {
	const message = tree.byId.get(id);
	if (!message) return null;
	const siblings = childrenOf(tree, message.parentId);
	const at = siblings.findIndex((s) => s.id === id);
	if (at < 0) return null;
	return {
		index: at + 1,
		count: siblings.length,
		prevId: siblings[at - 1]?.id ?? null,
		nextId: siblings[at + 1]?.id ?? null,
	};
}
