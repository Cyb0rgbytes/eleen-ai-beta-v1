/**
 * Long-term memory (M4.6): one fact per row in memory_entries, replacing the
 * single free-text KV profile under mem:v1:*.
 *
 * A fact is written into every later system prompt, so it is an injection
 * vector that outlives the conversation it came from. Each one is screened
 * here, at the only place facts are written, rather than trusting whoever
 * produced it (today a model summarising the user's own words).
 */
import { assessInjection, stripInvisible } from "../ai/guard";
import { MemoryEntry } from "../shared/history";

export const MAX_FACT_CHARS = 500;
/** The oldest facts are dropped beyond this, so the prompt stays bounded. */
export const MAX_FACTS = 50;

interface MemoryRow {
	id: string;
	fact: string;
	created_at: number;
}

function toEntry(row: MemoryRow): MemoryEntry {
	return { id: row.id, fact: row.fact, createdAt: row.created_at };
}

/** Oldest first: the order they were learnt, which reads naturally as a profile. */
export async function listMemory(db: D1Database, userId: string): Promise<MemoryEntry[]> {
	const { results } = await db
		.prepare("SELECT id, fact, created_at FROM memory_entries WHERE user_id = ? ORDER BY created_at, rowid")
		.bind(userId)
		.all<MemoryRow>();
	return results.map(toEntry);
}

export async function deleteMemoryEntry(db: D1Database, userId: string, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM memory_entries WHERE id = ? AND user_id = ?").bind(id, userId).run();
	return result.meta.changes > 0;
}

export async function deleteAllMemory(db: D1Database, userId: string): Promise<void> {
	await db.prepare("DELETE FROM memory_entries WHERE user_id = ?").bind(userId).run();
}

/**
 * Invisible smuggling characters removed (S2: a fact is replayed into every
 * later prompt, so it must not carry text the user cannot see), whitespace
 * collapsed, list markers stripped, capped. Empty means drop it.
 */
export function cleanFact(raw: string): string {
	return stripInvisible(raw)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
		.trim()
		.slice(0, MAX_FACT_CHARS)
		.trim();
}

function dedupeKey(fact: string): string {
	return fact.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Store new facts. Each is cleaned, screened with assessInjection (anything
 * that would harden or refuse a chat turn is dropped), and deduplicated
 * against what is already stored. Returns how many were written.
 *
 * The insert is conditional on consents.memory = 1 in the same statement, so
 * a fact extracted in the background cannot land after the user turned
 * memory off and had everything deleted.
 */
export async function addFacts(
	db: D1Database,
	userId: string,
	facts: readonly string[],
	sourceMessageId: string | null = null,
	now = Date.now(),
): Promise<number> {
	const existing = await listMemory(db, userId);
	const seen = new Set(existing.map((entry) => dedupeKey(entry.fact)));

	const fresh: string[] = [];
	for (const raw of facts) {
		const fact = cleanFact(raw);
		if (!fact) continue;
		const verdict = assessInjection(fact);
		if (verdict.harden || verdict.refuse) continue;
		const key = dedupeKey(fact);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		fresh.push(fact);
	}
	if (!fresh.length) return 0;

	const kept = fresh.slice(-MAX_FACTS);
	const statements = kept.map((fact, index) =>
		db
			.prepare(
				`INSERT INTO memory_entries (id, user_id, fact, source_message_id, created_at)
				SELECT ?1, ?2, ?3, (SELECT id FROM messages WHERE id = ?4 AND user_id = ?2), ?5
				WHERE EXISTS (SELECT 1 FROM consents WHERE user_id = ?2 AND memory = 1)`,
			)
			.bind(crypto.randomUUID(), userId, fact, sourceMessageId, now + index),
	);
	statements.push(
		db
			.prepare(
				`DELETE FROM memory_entries WHERE user_id = ?1 AND id NOT IN (
					SELECT id FROM memory_entries WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2
				)`,
			)
			.bind(userId, MAX_FACTS),
	);
	const results = await db.batch(statements);
	return results.slice(0, kept.length).reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}
