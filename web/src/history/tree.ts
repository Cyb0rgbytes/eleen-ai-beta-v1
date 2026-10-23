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

/**
 * Compare (M5.4): siblings that share a compareGroup are one turn answered
 * by several models, so the navigator and the walk down treat them as one
 * version, a slot. Every other message is a slot of its own.
 *
 * A slot's `primary` is the member the walk continues through: the one the
 * conversation went on from (the member with the newest child), else the
 * first lane, which is where the server puts the active leaf.
 */
export interface Slot {
	ids: string[];
	primary: string;
	group: string | null;
}

export function slotsOf(tree: Tree, parentId: string | null): Slot[] {
	const slots: Slot[] = [];
	const byGroup = new Map<string, Slot>();
	for (const message of childrenOf(tree, parentId)) {
		const group = message.compareGroup;
		const existing = group ? byGroup.get(group) : undefined;
		if (existing) {
			existing.ids.push(message.id);
			continue;
		}
		const slot: Slot = { ids: [message.id], primary: message.id, group: group ?? null };
		if (group) byGroup.set(group, slot);
		slots.push(slot);
	}
	for (const slot of byGroup.values()) {
		let newest = -1;
		for (const id of slot.ids) {
			const child = childrenOf(tree, id).at(-1);
			if (child && child.seq > newest) {
				newest = child.seq;
				slot.primary = id;
			}
		}
	}
	return slots;
}

/** The members of id's compare group in lane order, or null when it is not in one. */
export function compareMembers(tree: Tree, id: string): StoredMessage[] | null {
	const message = tree.byId.get(id);
	if (!message?.compareGroup) return null;
	return childrenOf(tree, message.parentId).filter((m) => m.compareGroup === message.compareGroup);
}

/** Follow the newest (highest seq) child down from id to a leaf; a compare turn is followed through its primary. */
export function deepestLeaf(tree: Tree, id: string): string {
	const seen = new Set<string>([id]);
	let current = id;
	for (;;) {
		const next = slotsOf(tree, current).at(-1)?.primary;
		if (!next || seen.has(next)) return current;
		seen.add(next);
		current = next;
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

/** Position among sibling slots: a compare turn counts once, however many models answered. */
export function siblingInfo(tree: Tree, id: string): SiblingInfo | null {
	const message = tree.byId.get(id);
	if (!message) return null;
	const slots = slotsOf(tree, message.parentId);
	const at = slots.findIndex((s) => s.ids.includes(id));
	if (at < 0) return null;
	return {
		index: at + 1,
		count: slots.length,
		prevId: slots[at - 1]?.primary ?? null,
		nextId: slots[at + 1]?.primary ?? null,
	};
}
