/**
 * What the user agreed to (M4.6). No row means the dialog was never answered,
 * which counts as history on and memory off: saving conversations is what a
 * signed-in user expects, remembering facts about them is not.
 */
import { Consent, ConsentUpdate, POLICY_VERSION } from "../shared/history";

interface ConsentRow {
	history: number;
	memory: number;
	policy_version: number;
	updated_at: number;
}

function toConsent(row: ConsentRow): Consent {
	return {
		history: row.history === 1,
		memory: row.memory === 1,
		policyVersion: row.policy_version,
		updatedAt: row.updated_at,
	};
}

export async function getConsent(db: D1Database, userId: string): Promise<Consent | null> {
	const row = await db
		.prepare("SELECT history, memory, policy_version, updated_at FROM consents WHERE user_id = ?")
		.bind(userId)
		.first<ConsentRow>();
	return row ? toConsent(row) : null;
}

/** The consent that applies to a request, with the defaults filled in. */
export function effectiveConsent(consent: Consent | null): { history: boolean; memory: boolean } {
	return consent ? { history: consent.history, memory: consent.memory } : { history: true, memory: false };
}

/**
 * Record the user's answer against the current policy version. Turning
 * memory off forgets every stored fact in the same transaction, so there is
 * no moment where memory is off but facts remain.
 */
export async function putConsent(
	db: D1Database,
	userId: string,
	update: ConsentUpdate,
	now = Date.now(),
): Promise<Consent> {
	const statements = [
		db
			.prepare(
				`INSERT INTO consents (user_id, history, memory, policy_version, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
				ON CONFLICT (user_id) DO UPDATE SET
					history = excluded.history,
					memory = excluded.memory,
					policy_version = excluded.policy_version,
					updated_at = excluded.updated_at`,
			)
			.bind(userId, update.history ? 1 : 0, update.memory ? 1 : 0, POLICY_VERSION, now),
	];
	if (!update.memory) {
		statements.push(db.prepare("DELETE FROM memory_entries WHERE user_id = ?").bind(userId));
	}
	await db.batch(statements);
	return { history: update.history, memory: update.memory, policyVersion: POLICY_VERSION, updatedAt: now };
}
