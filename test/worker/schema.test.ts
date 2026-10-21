/**
 * The M4.1 schema, exercised directly in D1: ownership columns, the message
 * tree, cascades and full-text search. The data layer (src/db) builds on
 * exactly these guarantees.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { normalizeForSearch, toMatchQuery } from "../../src/db/search";

const NOW = 1_792_600_000_000;

async function seed() {
	const db = env.DB;
	// Storage persists across the tests in a file; deleting the users
	// cascades to everything they own.
	await db.prepare("DELETE FROM users").run();
	await db.batch([
		db.prepare("INSERT INTO users (user_id, created_at, last_seen_at) VALUES ('alice', ?1, ?1), ('bob', ?1, ?1)").bind(NOW),
		db.prepare(
			"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('c1', 'alice', 'Passwords', ?1, ?1), ('c2', 'bob', 'Bob chat', ?1, ?1)",
		).bind(NOW),
	]);
	const message = (id: string, conv: string, user: string, parent: string | null, seq: number, role: string, content: string) =>
		db
			.prepare(
				"INSERT INTO messages (id, conversation_id, user_id, parent_id, seq, role, content, search_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(id, conv, user, parent, seq, role, content, normalizeForSearch(content), NOW + seq);
	await db.batch([
		message("m1", "c1", "alice", null, 1, "user", "How do I store passwords?"),
		message("m2", "c1", "alice", "m1", 2, "assistant", "Use bcrypt with a salt."),
		message("m3", "c1", "alice", "m1", 3, "assistant", "Use argon2, the newer choice."), // a regeneration: sibling of m2
		message("m4", "c1", "alice", "m2", 4, "user", "مَرْحَبًا بِكَ"),
		message("b1", "c2", "bob", null, 1, "user", "bob's secret about passwords"),
	]);
}

async function search(userId: string, input: string): Promise<string[]> {
	const query = toMatchQuery(input);
	if (!query) return [];
	const { results } = await env.DB.prepare(
		"SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? AND m.user_id = ? ORDER BY m.seq",
	)
		.bind(query, userId)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

describe("M4.1 schema", () => {
	beforeEach(seed);

	it("keeps regenerations as siblings of one parent, ordered by seq", async () => {
		const { results } = await env.DB.prepare(
			"SELECT id FROM messages WHERE conversation_id = ? AND user_id = ? AND parent_id = ? ORDER BY seq",
		)
			.bind("c1", "alice", "m1")
			.all<{ id: string }>();
		expect(results.map((r) => r.id)).toEqual(["m2", "m3"]);
	});

	it("walks the visible thread up from the active leaf", async () => {
		const { results } = await env.DB.prepare(
			`WITH RECURSIVE thread(id, parent_id, seq) AS (
				SELECT id, parent_id, seq FROM messages WHERE id = ? AND user_id = ?
				UNION ALL
				SELECT m.id, m.parent_id, m.seq FROM messages m JOIN thread t ON m.id = t.parent_id WHERE m.user_id = ?
			) SELECT id FROM thread ORDER BY seq`,
		)
			.bind("m4", "alice", "alice")
			.all<{ id: string }>();
		expect(results.map((r) => r.id)).toEqual(["m1", "m2", "m4"]);
	});

	it("refuses two messages with the same seq in a conversation, and an unknown role or status", async () => {
		const insert = (seq: number, role: string, status: string) =>
			env.DB.prepare(
				"INSERT INTO messages (id, conversation_id, user_id, seq, role, status, created_at) VALUES (?, 'c1', 'alice', ?, ?, ?, ?)",
			)
				.bind(crypto.randomUUID(), seq, role, status, NOW)
				.run();
		await expect(insert(1, "user", "complete")).rejects.toThrow();
		await expect(insert(99, "system", "complete")).rejects.toThrow();
		await expect(insert(99, "assistant", "pending")).rejects.toThrow();
	});

	it("searches only the caller's own messages", async () => {
		expect(await search("alice", "passwords")).toEqual(["m1"]);
		expect(await search("bob", "passwords")).toEqual(["b1"]);
		expect(await search("alice", "secret")).toEqual([]);
	});

	it("matches prefixes, and finds Arabic written with tashkeel from a plain query", async () => {
		expect(await search("alice", "bcry")).toEqual(["m2"]);
		expect(await search("alice", "مرحبا")).toEqual(["m4"]);
	});

	it("treats FTS syntax in a query as text", async () => {
		for (const hostile of ['passwords" OR "secret', "NEAR(a b)", "* -bcrypt", '"', "content:x"]) {
			await expect(search("alice", hostile), hostile).resolves.toBeInstanceOf(Array);
		}
		expect(await search("bob", 'passwords" OR "bcrypt')).toEqual([]);
	});

	it("keeps the index in step with edits and deletes", async () => {
		await env.DB.prepare("UPDATE messages SET content = ?1, search_text = ?1 WHERE id = 'm2' AND user_id = 'alice'")
			.bind("Use scrypt instead.")
			.run();
		expect(await search("alice", "bcrypt")).toEqual([]);
		expect(await search("alice", "scrypt")).toEqual(["m2"]);

		await env.DB.prepare("DELETE FROM conversations WHERE id = 'c1' AND user_id = 'alice'").run();
		expect(await search("alice", "argon2")).toEqual([]);
		const { results } = await env.DB.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id = 'c1'").all<{ n: number }>();
		expect(results[0]?.n).toBe(0);
	});

	it("defaults consent to history on and memory off", async () => {
		await env.DB.prepare("INSERT INTO consents (user_id, policy_version, updated_at) VALUES ('alice', 1, ?)").bind(NOW).run();
		const row = await env.DB.prepare("SELECT history, memory FROM consents WHERE user_id = 'alice'").first<{ history: number; memory: number }>();
		expect(row).toEqual({ history: 1, memory: 0 });
	});

	it("removes everything a user owns when the user is deleted", async () => {
		await env.DB.batch([
			env.DB.prepare("INSERT INTO folders (id, user_id, name, created_at, updated_at) VALUES ('f1', 'alice', 'Work', ?1, ?1)").bind(NOW),
			env.DB.prepare("INSERT INTO memory_entries (id, user_id, fact, created_at) VALUES ('e1', 'alice', 'Prefers Python', ?)").bind(NOW),
		]);
		await env.DB.prepare("DELETE FROM users WHERE user_id = 'alice'").run();
		for (const table of ["folders", "conversations", "messages", "memory_entries"]) {
			const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = 'alice'`).first<{ n: number }>();
			expect(row?.n, table).toBe(0);
		}
		const bob = await env.DB.prepare("SELECT count(*) AS n FROM messages WHERE user_id = 'bob'").first<{ n: number }>();
		expect(bob?.n).toBe(1);
	});
});

describe("normalizeForSearch", () => {
	it("strips tashkeel and tatweel and unifies alef forms", () => {
		expect(normalizeForSearch("مَرْحَبًا")).toBe("مرحبا");
		expect(normalizeForSearch("كتـــاب")).toBe("كتاب");
		expect(normalizeForSearch("أحمد إلى آخر")).toBe(normalizeForSearch("احمد الي اخر"));
	});
});
