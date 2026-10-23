/**
 * Conversations: the sidebar list, one conversation's whole message tree, and
 * the edits the sidebar makes (rename, pin, move, switch branch, delete).
 *
 * Every statement filters by user_id, including the ones that also name an
 * id: the id is the client's claim, the user_id is the server's.
 */
import {
	ConversationDetail,
	ConversationSummary,
	DELETED_RETENTION_DAYS,
	DeletedConversationList,
} from "../shared/history";
import { listMessages } from "./messages";

export const PAGE_SIZE = 50;
export const MAX_TITLE_CHARS = 200;

export interface ConversationRow {
	id: string;
	title: string;
	pinned: number;
	folder_id: string | null;
	active_leaf_id: string | null;
	created_at: number;
	updated_at: number;
}

const COLUMNS = "id, title, pinned, folder_id, active_leaf_id, created_at, updated_at";

export function toSummary(row: ConversationRow): ConversationSummary {
	return {
		id: row.id,
		title: row.title,
		pinned: row.pinned === 1,
		folderId: row.folder_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Where the next page starts: the sort key of the last row returned. */
interface Cursor {
	pinned: number;
	updatedAt: number;
	id: string;
}

function encodeCursor(row: ConversationRow): string {
	const json = JSON.stringify([row.pinned, row.updated_at, row.id]);
	return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not a cursor this module made. */
export function decodeCursor(value: string): Cursor | null {
	try {
		const json = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== 3) return null;
		const [pinned, updatedAt, id] = parsed as unknown[];
		if ((pinned !== 0 && pinned !== 1) || !Number.isSafeInteger(updatedAt) || typeof id !== "string") return null;
		return { pinned, updatedAt: updatedAt as number, id };
	} catch {
		return null;
	}
}

/**
 * One page of the caller's live conversations, pinned first, then most
 * recently updated. Keyset pagination on (pinned, updated_at, id), so a
 * conversation updated while the user scrolls cannot be skipped or repeated
 * by an offset shifting under it. `folder` is a folder id, "none" for
 * conversations in no folder, or undefined for all.
 */
export async function listConversations(
	db: D1Database,
	userId: string,
	options: { folder?: string; cursor?: Cursor | null; limit?: number } = {},
): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
	const limit = options.limit ?? PAGE_SIZE;
	const where = ["user_id = ?1", "deleted_at IS NULL"];
	const binds: unknown[] = [userId];

	if (options.folder === "none") {
		where.push("folder_id IS NULL");
	} else if (options.folder) {
		binds.push(options.folder);
		where.push(`folder_id = ?${binds.length}`);
	}

	const cursor = options.cursor;
	if (cursor) {
		binds.push(cursor.pinned, cursor.updatedAt, cursor.id);
		const [p, u, i] = [binds.length - 2, binds.length - 1, binds.length];
		where.push(`(pinned < ?${p} OR (pinned = ?${p} AND (updated_at < ?${u} OR (updated_at = ?${u} AND id < ?${i}))))`);
	}

	binds.push(limit + 1);
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM conversations WHERE ${where.join(" AND ")}
			ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?${binds.length}`,
		)
		.bind(...binds)
		.all<ConversationRow>();

	const page = results.slice(0, limit);
	const last = page[page.length - 1];
	return {
		conversations: page.map(toSummary),
		nextCursor: results.length > limit && last ? encodeCursor(last) : null,
	};
}

export async function createConversation(
	db: D1Database,
	userId: string,
	title = "",
	now = Date.now(),
	id: string = crypto.randomUUID(),
): Promise<ConversationSummary> {
	const row = await db
		.prepare(
			`INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
			RETURNING ${COLUMNS}`,
		)
		.bind(id, userId, title, now)
		.first<ConversationRow>();
	if (!row) throw new Error("Conversation insert returned no row");
	return toSummary(row);
}

/** A live (not deleted) conversation of the caller's, or null. */
export async function getConversation(db: D1Database, userId: string, id: string): Promise<ConversationRow | null> {
	return db
		.prepare(`SELECT ${COLUMNS} FROM conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
		.bind(id, userId)
		.first<ConversationRow>();
}

/**
 * A reply still marked streaming this long after it started will never
 * finish: its waitUntil was lost. It reads as stopped, so the client shows
 * what was saved instead of a spinner that never ends. The row is untouched.
 */
export const STALE_STREAMING_MS = 2 * 60_000;

export async function getConversationDetail(
	db: D1Database,
	userId: string,
	id: string,
	now = Date.now(),
): Promise<ConversationDetail | null> {
	const row = await getConversation(db, userId, id);
	if (!row) return null;
	const messages = await listMessages(db, userId, id);
	return {
		conversation: { ...toSummary(row), activeLeafId: row.active_leaf_id },
		messages: messages.map((message) =>
			message.status === "streaming" && now - message.createdAt > STALE_STREAMING_MS
				? { ...message, status: "stopped" as const }
				: message,
		),
	};
}

export interface ConversationPatch {
	title?: string;
	pinned?: boolean;
	/** null moves it out of any folder. */
	folderId?: string | null;
	activeLeafId?: string;
}

/**
 * Apply a partial update. The caller has already checked that a named folder
 * and leaf are the user's; the subqueries repeat that check inside the
 * statement, so a folder deleted in between becomes "no folder" rather than a
 * dangling id, and a leaf can never be set to a message outside this
 * conversation or this user.
 */
export async function updateConversation(
	db: D1Database,
	userId: string,
	id: string,
	patch: ConversationPatch,
): Promise<ConversationSummary | null> {
	const sets: string[] = [];
	const binds: unknown[] = [id, userId];
	const bind = (value: unknown) => {
		binds.push(value);
		return `?${binds.length}`;
	};

	if (patch.title !== undefined) sets.push(`title = ${bind(patch.title)}`);
	if (patch.pinned !== undefined) sets.push(`pinned = ${bind(patch.pinned ? 1 : 0)}`);
	if (patch.folderId !== undefined) {
		sets.push(
			patch.folderId === null
				? "folder_id = NULL"
				: `folder_id = (SELECT id FROM folders WHERE id = ${bind(patch.folderId)} AND user_id = ?2)`,
		);
	}
	if (patch.activeLeafId !== undefined) {
		const leaf = bind(patch.activeLeafId);
		sets.push(
			`active_leaf_id = COALESCE((SELECT id FROM messages WHERE id = ${leaf} AND conversation_id = ?1 AND user_id = ?2), active_leaf_id)`,
		);
	}
	// Renaming or pinning is not activity: updated_at orders the sidebar by
	// conversation, and it should not jump to the top because it was renamed.
	if (!sets.length) {
		const row = await getConversation(db, userId, id);
		return row ? toSummary(row) : null;
	}

	const row = await db
		.prepare(
			`UPDATE conversations SET ${sets.join(", ")}
			WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
			RETURNING ${COLUMNS}`,
		)
		.bind(...binds)
		.first<ConversationRow>();
	return row ? toSummary(row) : null;
}

/**
 * Soft delete hides the conversation everywhere but keeps its rows, so a
 * mistaken delete can be undone for DELETED_RETENTION_DAYS, after which the
 * daily purge removes it. A purge removes it and, by cascade, every
 * message and its search index entries. A purge also reaches a conversation
 * that is already soft-deleted.
 */
export async function deleteConversation(
	db: D1Database,
	userId: string,
	id: string,
	purge: boolean,
	now = Date.now(),
): Promise<boolean> {
	const result = purge
		? await db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").bind(id, userId).run()
		: await db
				.prepare("UPDATE conversations SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
				.bind(now, id, userId)
				.run();
	return result.meta.changes > 0;
}

export const DELETED_RETENTION_MS = DELETED_RETENTION_DAYS * 24 * 60 * 60_000;

/**
 * Undo a soft delete. Null if it is not the caller's, not deleted, purged,
 * or past the retention window (it is then waiting for the purge, and
 * restoring it would contradict what the Recently deleted list promised).
 */
export async function restoreConversation(
	db: D1Database,
	userId: string,
	id: string,
	now = Date.now(),
): Promise<ConversationSummary | null> {
	const row = await db
		.prepare(
			`UPDATE conversations SET deleted_at = NULL
			WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL AND deleted_at > ?
			RETURNING ${COLUMNS}`,
		)
		.bind(id, userId, now - DELETED_RETENTION_MS)
		.first<ConversationRow>();
	return row ? toSummary(row) : null;
}

interface DeletedRow extends ConversationRow {
	deleted_at: number;
}

function encodeDeletedCursor(row: DeletedRow): string {
	return btoa(JSON.stringify(["d", row.deleted_at, row.id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not a deleted-list cursor this module made. */
export function decodeDeletedCursor(value: string): { deletedAt: number; id: string } | null {
	try {
		const parsed = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== "d") return null;
		const [, deletedAt, id] = parsed as unknown[];
		if (!Number.isSafeInteger(deletedAt) || typeof id !== "string") return null;
		return { deletedAt: deletedAt as number, id };
	} catch {
		return null;
	}
}

/** The caller's soft-deleted conversations still inside the window, most recently deleted first. */
export async function listDeletedConversations(
	db: D1Database,
	userId: string,
	options: { cursor?: { deletedAt: number; id: string } | null; limit?: number; now?: number } = {},
): Promise<DeletedConversationList> {
	const limit = options.limit ?? PAGE_SIZE;
	const now = options.now ?? Date.now();
	const binds: unknown[] = [userId, now - DELETED_RETENTION_MS];
	let after = "";
	if (options.cursor) {
		binds.push(options.cursor.deletedAt, options.cursor.id);
		after = "AND (deleted_at < ?3 OR (deleted_at = ?3 AND id < ?4))";
	}
	binds.push(limit + 1);
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS}, deleted_at FROM conversations
			WHERE user_id = ?1 AND deleted_at IS NOT NULL AND deleted_at > ?2 ${after}
			ORDER BY deleted_at DESC, id DESC LIMIT ?${binds.length}`,
		)
		.bind(...binds)
		.all<DeletedRow>();
	const page = results.slice(0, limit);
	const last = page[page.length - 1];
	return {
		conversations: page.map((row) => ({ ...toSummary(row), deletedAt: row.deleted_at })),
		nextCursor: results.length > limit && last ? encodeDeletedCursor(last) : null,
	};
}

/**
 * Remove, for good, every conversation deleted longer ago than the window,
 * across all users (the daily cron). Messages and their search entries go
 * with them by cascade. Batched so one run stays small; returns the count.
 */
export async function purgeExpiredConversations(db: D1Database, now = Date.now(), batch = 200, maxBatches = 25): Promise<number> {
	let purged = 0;
	for (let i = 0; i < maxBatches; i++) {
		// RETURNING, not meta.changes: changes also counts the cascaded
		// message and search-index rows.
		const { results } = await db
			.prepare(
				`DELETE FROM conversations WHERE id IN (
					SELECT id FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at <= ? LIMIT ?
				) RETURNING id`,
			)
			.bind(now - DELETED_RETENTION_MS, batch)
			.all<{ id: string }>();
		purged += results.length;
		if (results.length < batch) break;
	}
	return purged;
}

/** Every conversation the caller has, live or soft-deleted, for good. */
export async function deleteAllConversations(db: D1Database, userId: string): Promise<void> {
	await db.prepare("DELETE FROM conversations WHERE user_id = ?").bind(userId).run();
}
