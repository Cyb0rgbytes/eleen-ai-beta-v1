/**
 * Prepaid credits for EleenAI Studio (migrations/0005_credits.sql).
 *
 * A paid generation holds credits, then either settles (they are spent) or
 * releases (they come back). Every change is one ledger INSERT guarded in its
 * own SELECT, and a trigger applies it to the balance, so the check and the
 * write cannot be separated, the same reasoning as CONSUME_SQL in ratelimit.ts.
 *
 * Unique indexes make each step idempotent. No row back means the step did
 * not happen now, so the caller reads the ledger to learn why: that is what
 * lets a webhook be delivered twice, and a retry after an error charge once.
 *
 * Nothing here catches a database error. Credits fail closed: if D1 is down
 * the error reaches the caller and no paid work starts.
 */

export type HoldResult =
	| { ok: true; balance: number; replayed: boolean }
	| { ok: false; reason: "insufficient" | "conflict" };

/** How a hold ended, as far as the ledger knows. */
export type HoldState = "open" | "charged" | "released" | "missing";

const HOLD_SQL = `
INSERT INTO credit_ledger (user_id, kind, delta, balance_after, reference, created_at)
SELECT ?1, 'hold', -?2, b.balance - ?2, ?3, ?4
FROM credit_balance b
WHERE b.user_id = ?1
	AND b.balance >= ?2
	AND b.shortfall = 0
	AND (b.expires_at IS NULL OR b.expires_at > ?4)
ON CONFLICT DO NOTHING
RETURNING balance_after`;

const HELD_SQL = "SELECT user_id, delta FROM credit_ledger WHERE reference = ?1 AND kind = 'hold'";

/** A terminal entry for an existing hold. `delta` is an SQL expression over the hold row. */
function closeSql(kind: "charge" | "release", delta: string): string {
	return `
INSERT INTO credit_ledger (user_id, kind, delta, balance_after, reference, created_at)
SELECT h.user_id, '${kind}', ${delta}, b.balance + ${delta}, h.reference, ?2
FROM credit_ledger h
JOIN credit_balance b ON b.user_id = h.user_id
WHERE h.reference = ?1 AND h.kind = 'hold'
ON CONFLICT DO NOTHING
RETURNING balance_after`;
}

/** The credits were spent. They left the balance at the hold, so nothing moves. */
const SETTLE_SQL = closeSql("charge", "0");
/** The credits come back: the hold's delta, negated. */
const RELEASE_SQL = closeSql("release", "-h.delta");

/** Set aside `amount` credits against `reference`. Holding the same reference again is a no-op. */
export async function hold(
	db: D1Database,
	userId: string,
	amount: number,
	reference: string,
	now = Date.now(),
): Promise<HoldResult> {
	if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("A hold must be a positive whole number of credits");

	const row = await db.prepare(HOLD_SQL).bind(userId, amount, reference, now).first<{ balance_after: number }>();
	if (row) return { ok: true, balance: row.balance_after, replayed: false };

	const held = await db.prepare(HELD_SQL).bind(reference).first<{ user_id: string; delta: number }>();
	if (!held) return { ok: false, reason: "insufficient" };
	// The same reference for another user or price is a bug, never a replay.
	if (held.user_id !== userId || held.delta !== -amount) return { ok: false, reason: "conflict" };
	return { ok: true, balance: await balance(db, userId), replayed: true };
}

/** What became of a hold. */
export async function holdState(db: D1Database, reference: string): Promise<HoldState> {
	const { results } = await db
		.prepare("SELECT kind FROM credit_ledger WHERE reference = ?1 AND kind IN ('hold', 'charge', 'release')")
		.bind(reference)
		.all<{ kind: string }>();
	const kinds = results.map((row) => row.kind);
	if (kinds.includes("charge")) return "charged";
	if (kinds.includes("release")) return "released";
	return kinds.includes("hold") ? "open" : "missing";
}

/**
 * Spend a hold. Returns what the hold ended as: "charged" when it is spent,
 * and "released" when a refund got there first. A success that arrives after
 * a refund must not debit: the caller delivers it free and raises an alert.
 */
export async function settle(db: D1Database, reference: string, now = Date.now()): Promise<HoldState> {
	await db.prepare(SETTLE_SQL).bind(reference, now).run();
	return holdState(db, reference);
}

/** Give a hold back. Returns "charged" when it was already spent, in which case nothing moved. */
export async function release(db: D1Database, reference: string, now = Date.now()): Promise<HoldState> {
	await db.prepare(RELEASE_SQL).bind(reference, now).run();
	return holdState(db, reference);
}

/**
 * Add credits, once per reference: an owner grant or a paid order. `expiresAt`
 * can only push the balance's expiry later. Returns false for a replay.
 */
export async function addCredits(
	db: D1Database,
	userId: string,
	kind: "grant" | "purchase",
	amount: number,
	reference: string,
	expiresAt: number | null,
	now = Date.now(),
): Promise<boolean> {
	if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Credits must be a positive whole number");

	const [, inserted] = await db.batch<{ balance_after: number }>([
		db
			.prepare("INSERT INTO credit_balance (user_id, balance, updated_at) VALUES (?1, 0, ?2) ON CONFLICT DO NOTHING")
			.bind(userId, now),
		db
			.prepare(
				`INSERT INTO credit_ledger (user_id, kind, delta, balance_after, reference, expires_at, created_at)
				SELECT ?1, ?2, ?3, b.balance + ?3, ?4, ?5, ?6
				FROM credit_balance b
				WHERE b.user_id = ?1
				ON CONFLICT DO NOTHING
				RETURNING balance_after`,
			)
			.bind(userId, kind, amount, reference, expiresAt, now),
	]);
	return inserted.results.length > 0;
}

/**
 * Take back the credits of a refunded or charged-back order, once per
 * reference. Some may be spent already, and the balance can't go below zero,
 * so what can't be taken is recorded as a shortfall, which blocks new holds
 * until the owner resolves it. Both land in one statement.
 */
export async function reverseCredits(
	db: D1Database,
	userId: string,
	kind: "refund" | "chargeback",
	amount: number,
	reference: string,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO credit_ledger (user_id, kind, delta, balance_after, reference, shortfall, created_at)
			SELECT ?1, ?2, -MIN(b.balance, ?3), b.balance - MIN(b.balance, ?3), ?4, ?3 - MIN(b.balance, ?3), ?5
			FROM credit_balance b
			WHERE b.user_id = ?1
			ON CONFLICT DO NOTHING`,
		)
		.bind(userId, kind, amount, reference, now)
		.run();
}

/** The caller's spendable credits: zero once the balance has expired. */
export async function balance(db: D1Database, userId: string, now = Date.now()): Promise<number> {
	const row = await db
		.prepare("SELECT balance, expires_at FROM credit_balance WHERE user_id = ?1")
		.bind(userId)
		.first<{ balance: number; expires_at: number | null }>();
	if (!row) return 0;
	return row.expires_at !== null && row.expires_at <= now ? 0 : row.balance;
}
