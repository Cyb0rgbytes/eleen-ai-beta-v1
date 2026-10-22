/**
 * The users row every other table hangs off (migrations/0003_core.sql).
 *
 * Created on first use rather than at sign-up: Clerk owns the account, and a
 * signed-in user who never chats needs no row. D1 enforces the foreign keys,
 * so this runs before anything is written on the user's behalf.
 */

/** last_seen_at is refreshed at most this often, so most requests write nothing. */
const SEEN_GRANULARITY_MS = 60 * 60 * 1000;

/**
 * Make sure the user's row exists. Returns true when this call created it,
 * which is the one moment worth doing first-use work (the legacy memory purge).
 *
 * One statement: when the row exists and was seen recently the update is
 * skipped and RETURNING yields nothing; when it was created, created_at is
 * the timestamp passed in.
 */
export async function ensureUser(db: D1Database, userId: string, now = Date.now()): Promise<boolean> {
	const row = await db
		.prepare(
			`INSERT INTO users (user_id, created_at, last_seen_at) VALUES (?1, ?2, ?2)
			ON CONFLICT (user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
				WHERE users.last_seen_at < ?3
			RETURNING created_at, last_seen_at`,
		)
		.bind(userId, now, now - SEEN_GRANULARITY_MS)
		.first<{ created_at: number; last_seen_at: number }>();
	return row !== null && row.created_at === now && row.last_seen_at === now;
}
