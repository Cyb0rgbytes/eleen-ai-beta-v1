/**
 * Sidebar folders. Every statement names the user, so a folder id from the
 * client is only ever looked up among the caller's own.
 */
import { Folder } from "../shared/history";

interface FolderRow {
	id: string;
	name: string;
	position: number;
}

function toFolder(row: FolderRow): Folder {
	return { id: row.id, name: row.name, position: row.position };
}

export async function listFolders(db: D1Database, userId: string): Promise<Folder[]> {
	const { results } = await db
		.prepare("SELECT id, name, position FROM folders WHERE user_id = ? ORDER BY position, created_at")
		.bind(userId)
		.all<FolderRow>();
	return results.map(toFolder);
}

/** A new folder goes at the end. */
export async function createFolder(db: D1Database, userId: string, name: string, now = Date.now()): Promise<Folder> {
	const row = await db
		.prepare(
			`INSERT INTO folders (id, user_id, name, position, created_at, updated_at)
			SELECT ?1, ?2, ?3, COALESCE(MAX(position), -1) + 1, ?4, ?4 FROM folders WHERE user_id = ?2
			RETURNING id, name, position`,
		)
		.bind(crypto.randomUUID(), userId, name, now)
		.first<FolderRow>();
	if (!row) throw new Error("Folder insert returned no row");
	return toFolder(row);
}

/** Null when the folder is not the caller's. */
export async function updateFolder(
	db: D1Database,
	userId: string,
	id: string,
	patch: { name?: string; position?: number },
	now = Date.now(),
): Promise<Folder | null> {
	const row = await db
		.prepare(
			`UPDATE folders SET
				name = COALESCE(?3, name),
				position = COALESCE(?4, position),
				updated_at = ?5
			WHERE id = ?1 AND user_id = ?2
			RETURNING id, name, position`,
		)
		.bind(id, userId, patch.name ?? null, patch.position ?? null, now)
		.first<FolderRow>();
	return row ? toFolder(row) : null;
}

/**
 * Remove a folder; its conversations move to no folder. The foreign key would
 * do that on its own, but saying it here keeps the behaviour visible and
 * scoped to the caller's rows.
 */
export async function deleteFolder(db: D1Database, userId: string, id: string): Promise<boolean> {
	const [, removed] = await db.batch([
		db.prepare("UPDATE conversations SET folder_id = NULL WHERE folder_id = ?1 AND user_id = ?2").bind(id, userId),
		db.prepare("DELETE FROM folders WHERE id = ?1 AND user_id = ?2").bind(id, userId),
	]);
	return (removed?.meta.changes ?? 0) > 0;
}

export async function folderExists(db: D1Database, userId: string, id: string): Promise<boolean> {
	const row = await db.prepare("SELECT 1 AS ok FROM folders WHERE id = ? AND user_id = ?").bind(id, userId).first();
	return row !== null;
}
