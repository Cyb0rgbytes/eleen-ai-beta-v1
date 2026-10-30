/**
 * The global daily ceiling on what Studio spends at providers.
 *
 * Paid generation reserves its provider cost here before it holds credits, so
 * a bug in pricing or a run of abuse stops at a known figure, even for traffic
 * AI Gateway can't see. Amounts are millionths of a dollar.
 *
 * This deliberately does not use checkRateLimit, which lets signed-in users
 * through when D1 is down. Spending money is the opposite case: an unset
 * ceiling, a refused reservation and a database error all mean no.
 */

const RESERVE_SQL = `
INSERT INTO studio_spend (day, micros)
VALUES (?1, ?2)
ON CONFLICT (day) DO UPDATE
	SET micros = micros + excluded.micros
	WHERE micros + excluded.micros <= ?3
RETURNING micros`;

/** The UTC day a reservation counts against. Stored on the job, to give it back. */
export function spendDay(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

/** The ceiling from STUDIO_DAILY_SPEND_MICROS, or null when it is not a positive whole number. */
export function parseCeiling(value: string | undefined): number | null {
	const ceiling = Number(value);
	return value && Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : null;
}

/** Reserve `micros` against today's ceiling. Never throws: any failure is a refusal. */
export async function reserveSpend(db: D1Database, ceiling: number | null, micros: number, day: string): Promise<boolean> {
	// The insert path has no WHERE clause, so a first request over the ceiling is refused here.
	if (ceiling === null || micros > ceiling) return false;
	try {
		const row = await db.prepare(RESERVE_SQL).bind(day, micros, ceiling).first();
		return row !== null;
	} catch (error) {
		console.error("Spend store unavailable:", error instanceof Error ? error.message : "unknown");
		return false;
	}
}

/** Hand back a reservation for work that never ran. */
export async function releaseSpend(db: D1Database, micros: number, day: string): Promise<void> {
	await db
		.prepare("UPDATE studio_spend SET micros = MAX(micros - ?2, 0) WHERE day = ?1")
		.bind(day, micros)
		.run();
}
