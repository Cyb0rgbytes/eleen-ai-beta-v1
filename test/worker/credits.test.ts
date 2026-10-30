/**
 * The credit ledger and spend ceiling, against real D1. The ledger cannot be
 * cleared between tests (it refuses DELETE), so each test uses its own user.
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { addCredits, balance, hold, holdState, release, settle } from "../../src/lib/credits";
import { parseCeiling, releaseSpend, reserveSpend, spendDay } from "../../src/lib/spend";

const NOW = 1_792_600_000_000;
const db = env.DB;

let counter = 0;
const unique = (label: string) => `${label}-${++counter}`;

async function funded(credits: number, expiresAt: number | null = null): Promise<string> {
	const userId = unique("user");
	await addCredits(db, userId, "grant", credits, unique("grant"), expiresAt, NOW);
	return userId;
}

async function entries(reference: string) {
	const { results } = await db
		.prepare("SELECT kind, delta, balance_after FROM credit_ledger WHERE reference = ?1 ORDER BY seq")
		.bind(reference)
		.all();
	return results;
}

/** What the ledger adds up to must always equal the stored balance. */
async function expectReconciled(userId: string) {
	const row = await db
		.prepare(
			`SELECT (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE user_id = ?1) AS total,
				(SELECT balance FROM credit_balance WHERE user_id = ?1) AS stored`,
		)
		.bind(userId)
		.first<{ total: number; stored: number }>();
	expect(row?.total).toBe(row?.stored);
}

describe("adding credits", () => {
	it("applies once per reference", async () => {
		const userId = unique("user");
		const reference = unique("order");
		expect(await addCredits(db, userId, "purchase", 500, reference, null, NOW)).toBe(true);
		expect(await addCredits(db, userId, "purchase", 500, reference, null, NOW)).toBe(false);
		expect(await balance(db, userId, NOW)).toBe(500);
		await expectReconciled(userId);
	});

	it("only pushes the expiry later", async () => {
		const userId = await funded(100, NOW + 1000);
		await addCredits(db, userId, "grant", 100, unique("grant"), NOW + 500, NOW);
		expect(await balance(db, userId, NOW + 999)).toBe(200);
		expect(await balance(db, userId, NOW + 1000)).toBe(0);
	});

	it("refuses a credit amount that is not a positive whole number", async () => {
		await expect(addCredits(db, unique("user"), "grant", 0, unique("grant"), null, NOW)).rejects.toThrow();
		await expect(addCredits(db, unique("user"), "grant", 1.5, unique("grant"), null, NOW)).rejects.toThrow();
	});
});

describe("hold", () => {
	it("takes the credits and refuses what the balance can't cover", async () => {
		const userId = await funded(100);
		expect(await hold(db, userId, 60, unique("job"), NOW)).toEqual({ ok: true, balance: 40, replayed: false });
		expect(await hold(db, userId, 41, unique("job"), NOW)).toEqual({ ok: false, reason: "insufficient" });
		expect(await balance(db, userId, NOW)).toBe(40);
		await expectReconciled(userId);
	});

	it("refuses a user with no balance row", async () => {
		expect(await hold(db, unique("user"), 1, unique("job"), NOW)).toEqual({ ok: false, reason: "insufficient" });
	});

	it("refuses credits that have expired", async () => {
		const userId = await funded(100, NOW);
		expect(await hold(db, userId, 1, unique("job"), NOW)).toEqual({ ok: false, reason: "insufficient" });
	});

	it("never overspends under concurrent holds", async () => {
		const userId = await funded(100);
		const results = await Promise.all(Array.from({ length: 20 }, () => hold(db, userId, 30, unique("job"), NOW)));
		expect(results.filter((result) => result.ok)).toHaveLength(3);
		expect(await balance(db, userId, NOW)).toBe(10);
		await expectReconciled(userId);
	});

	it("takes the credits once for concurrent holds on one reference", async () => {
		const userId = await funded(100);
		const job = unique("job");
		const results = await Promise.all(Array.from({ length: 5 }, () => hold(db, userId, 30, job, NOW)));
		expect(results.every((result) => result.ok)).toBe(true);
		expect(await balance(db, userId, NOW)).toBe(70);
	});

	it("treats the same reference with another price or user as a conflict", async () => {
		const userId = await funded(100);
		const other = await funded(100);
		const job = unique("job");
		await hold(db, userId, 30, job, NOW);
		expect(await hold(db, userId, 31, job, NOW)).toEqual({ ok: false, reason: "conflict" });
		expect(await hold(db, other, 30, job, NOW)).toEqual({ ok: false, reason: "conflict" });
		expect(await balance(db, other, NOW)).toBe(100);
	});
});

describe("settle and release", () => {
	it("settling spends the hold, and replaying changes nothing", async () => {
		const userId = await funded(100);
		const job = unique("job");
		await hold(db, userId, 30, job, NOW);
		expect(await settle(db, job, NOW)).toBe("charged");
		expect(await settle(db, job, NOW)).toBe("charged");
		expect(await balance(db, userId, NOW)).toBe(70);
		expect(await entries(job)).toEqual([
			{ kind: "hold", delta: -30, balance_after: 70 },
			{ kind: "charge", delta: 0, balance_after: 70 },
		]);
	});

	it("releasing returns the credits exactly once", async () => {
		const userId = await funded(100);
		const job = unique("job");
		await hold(db, userId, 30, job, NOW);
		expect(await release(db, job, NOW)).toBe("released");
		expect(await release(db, job, NOW)).toBe("released");
		expect(await balance(db, userId, NOW)).toBe(100);
		await expectReconciled(userId);
	});

	it("a release cannot undo a settled hold", async () => {
		const userId = await funded(100);
		const job = unique("job");
		await hold(db, userId, 30, job, NOW);
		await settle(db, job, NOW);
		expect(await release(db, job, NOW)).toBe("charged");
		expect(await balance(db, userId, NOW)).toBe(70);
	});

	it("a late success after a refund does not debit, and says so", async () => {
		const userId = await funded(100);
		const job = unique("job");
		await hold(db, userId, 30, job, NOW);
		await release(db, job, NOW);
		expect(await settle(db, job, NOW)).toBe("released");
		expect(await balance(db, userId, NOW)).toBe(100);
	});

	it("only one of a concurrent settle and release lands", async () => {
		const userId = await funded(100);
		const job = unique("job");
		await hold(db, userId, 30, job, NOW);
		await Promise.all([settle(db, job, NOW), release(db, job, NOW), settle(db, job, NOW), release(db, job, NOW)]);
		const state = await holdState(db, job);
		expect(await balance(db, userId, NOW)).toBe(state === "charged" ? 70 : 100);
		expect(await entries(job)).toHaveLength(2);
		await expectReconciled(userId);
	});

	it("reports a reference that was never held", async () => {
		const job = unique("job");
		expect(await settle(db, job, NOW)).toBe("missing");
		expect(await release(db, job, NOW)).toBe("missing");
		expect(await entries(job)).toEqual([]);
	});
});

describe("the ledger", () => {
	it("refuses updates and deletes", async () => {
		const userId = await funded(100);
		const job = unique("job");
		await hold(db, userId, 30, job, NOW);
		await expect(db.prepare("UPDATE credit_ledger SET delta = 0 WHERE reference = ?1").bind(job).run()).rejects.toThrow(/append-only/);
		await expect(db.prepare("DELETE FROM credit_ledger WHERE reference = ?1").bind(job).run()).rejects.toThrow(/append-only/);
	});

	it("refuses a balance below zero even if a guard were missed", async () => {
		const userId = await funded(10);
		await expect(
			db
				.prepare("INSERT INTO credit_ledger (user_id, kind, delta, balance_after, reference, created_at) VALUES (?1, 'hold', -11, -1, ?2, ?3)")
				.bind(userId, unique("job"), NOW)
				.run(),
		).rejects.toThrow();
		expect(await balance(db, userId, NOW)).toBe(10);
		await expectReconciled(userId);
	});
});

describe("spend ceiling", () => {
	it("refuses past the ceiling and gives back on release", async () => {
		const day = unique("day");
		expect(await reserveSpend(db, 100, 60, day)).toBe(true);
		expect(await reserveSpend(db, 100, 41, day)).toBe(false);
		await releaseSpend(db, 60, day);
		expect(await reserveSpend(db, 100, 100, day)).toBe(true);
	});

	it("refuses a first reservation over the ceiling", async () => {
		expect(await reserveSpend(db, 100, 101, unique("day"))).toBe(false);
	});

	it("never overcommits under concurrency", async () => {
		const day = unique("day");
		const results = await Promise.all(Array.from({ length: 10 }, () => reserveSpend(db, 100, 30, day)));
		expect(results.filter(Boolean)).toHaveLength(3);
	});

	it("fails closed with no ceiling or a broken database", async () => {
		expect(await reserveSpend(db, null, 1, unique("day"))).toBe(false);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
		expect(await reserveSpend(broken, 100, 1, unique("day"))).toBe(false);
		error.mockRestore();
	});

	it("reads the ceiling strictly", () => {
		expect(parseCeiling("5000000")).toBe(5_000_000);
		for (const value of [undefined, "", "0", "-1", "1.5", "lots"]) expect(parseCeiling(value)).toBeNull();
	});

	it("names the UTC day", () => {
		expect(spendDay(Date.UTC(2026, 9, 31, 23, 59))).toBe("2026-10-31");
	});
});
