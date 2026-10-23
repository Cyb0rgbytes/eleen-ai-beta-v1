/**
 * Messages: the tree inside a conversation, the thread a reply is built from,
 * saved turns, and full-text search.
 *
 * messages carries user_id itself, so every statement here checks ownership
 * on the message row without needing a join. search_text is always written
 * as normalizeForSearch(content): the FTS index is built over it.
 */
import { MessageStatus, SearchHit, StoredMessage } from "../shared/history";
import type { FileRef } from "../shared/files";
import { normalizeForSearch, toMatchQuery } from "./search";

interface MessageRow {
	id: string;
	parent_id: string | null;
	seq: number;
	role: "user" | "assistant";
	content: string;
	reasoning: string | null;
	model: string | null;
	status: MessageStatus;
	compare_group: string | null;
	completion_tokens: number | null;
	created_at: number;
	files: string | null;
}

/** The files column (migrations/0004): a JSON FileRef[] or NULL. Anything unreadable is no files. */
export function parseFiles(raw: string | null | undefined): FileRef[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(f): f is FileRef =>
				typeof f === "object" && f !== null && typeof (f as FileRef).id === "string" && typeof (f as FileRef).name === "string",
		);
	} catch {
		return [];
	}
}

function toStored(row: MessageRow): StoredMessage {
	return {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		role: row.role,
		content: row.content,
		reasoning: row.reasoning,
		model: row.model,
		status: row.status,
		compareGroup: row.compare_group,
		completionTokens: row.completion_tokens,
		createdAt: row.created_at,
		...(parseFiles(row.files).length ? { files: parseFiles(row.files) } : {}),
	};
}

/** The whole tree, in creation order. */
export async function listMessages(db: D1Database, userId: string, conversationId: string): Promise<StoredMessage[]> {
	const { results } = await db
		.prepare(
			`SELECT id, parent_id, seq, role, content, reasoning, model, status, compare_group, completion_tokens, created_at, files
			FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY seq`,
		)
		.bind(conversationId, userId)
		.all<MessageRow>();
	return results.map(toStored);
}

/** One of the caller's messages in one of their conversations, or null. */
export async function getMessageRef(
	db: D1Database,
	userId: string,
	conversationId: string,
	id: string,
): Promise<{ id: string; role: "user" | "assistant"; parent_id: string | null } | null> {
	return db
		.prepare("SELECT id, role, parent_id FROM messages WHERE id = ? AND conversation_id = ? AND user_id = ?")
		.bind(id, conversationId, userId)
		.first();
}

export async function hasMessages(db: D1Database, userId: string, conversationId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS ok FROM messages WHERE conversation_id = ? AND user_id = ? LIMIT 1")
		.bind(conversationId, userId)
		.first();
	return row !== null;
}

export interface ThreadMessage {
	role: "user" | "assistant";
	content: string;
	status: MessageStatus;
	/** JSON FileRef[] on a user turn that had attachments (M5.2). */
	files?: string | null;
}

/**
 * The visible thread ending at `leafId`, oldest first, at most `limit`
 * messages (the newest ones). Every step of the walk re-checks user_id and
 * conversation_id, so a parent pointer can never lead into another user's
 * rows. Reasoning is not selected: a model's thinking is never sent back.
 */
export async function loadThread(
	db: D1Database,
	userId: string,
	conversationId: string,
	leafId: string,
	limit: number,
): Promise<ThreadMessage[]> {
	const { results } = await db
		.prepare(
			`WITH RECURSIVE thread(id, parent_id, role, content, status, files, depth) AS (
				SELECT id, parent_id, role, content, status, files, 0 FROM messages
				WHERE id = ?1 AND user_id = ?2 AND conversation_id = ?3
				UNION ALL
				SELECT m.id, m.parent_id, m.role, m.content, m.status, m.files, t.depth + 1
				FROM messages m JOIN thread t ON m.id = t.parent_id
				WHERE m.user_id = ?2 AND m.conversation_id = ?3 AND t.depth + 1 < ?4
			)
			SELECT role, content, status, files FROM thread ORDER BY depth DESC`,
		)
		.bind(leafId, userId, conversationId, limit)
		.all<ThreadMessage>();
	return results;
}

export interface NewTurn {
	conversationId: string;
	/** Insert the conversation in the same transaction, with this title. */
	createWithTitle?: string;
	/** Set the title only while it is still empty (first turn of a conversation). */
	titleIfEmpty?: string;
	/** The new user message; absent on a regenerate. */
	user?: { id: string; parentId: string | null; content: string; files?: FileRef[] };
	assistant: { id: string; parentId: string; model: string };
	/**
	 * Compare (M5.4): more replies to the same turn, written after
	 * `assistant`, all of them sharing compare_group `group`. `assistant`
	 * (lane 0) becomes the active leaf.
	 */
	compare?: { group: string; siblings: { id: string; model: string }[] };
}

/**
 * Write a turn in one transaction: the conversation (if new), the user
 * message (if any), and an empty assistant row with status 'streaming' that
 * finishReply fills in. seq is taken as MAX + 1 inside each INSERT, so two
 * turns written at once cannot both claim the same number.
 */
export async function insertTurn(db: D1Database, userId: string, turn: NewTurn, now = Date.now()): Promise<void> {
	const statements: D1PreparedStatement[] = [];

	if (turn.createWithTitle !== undefined) {
		statements.push(
			db
				.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
				.bind(turn.conversationId, userId, turn.createWithTitle, now),
		);
	}

	// Compare lanes share one group; user rows never carry it.
	const group = turn.compare?.group ?? null;
	const insert = (
		id: string,
		parentId: string | null,
		role: "user" | "assistant",
		content: string,
		status: MessageStatus,
		model: string | null,
		files: FileRef[] = [],
	) =>
		db
			.prepare(
				`INSERT INTO messages (id, conversation_id, user_id, parent_id, seq, role, content, search_text, model, status, compare_group, created_at, files)
				SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(seq), 0) + 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
				FROM messages WHERE conversation_id = ?2 AND user_id = ?3`,
			)
			.bind(
				id,
				turn.conversationId,
				userId,
				parentId,
				role,
				content,
				normalizeForSearch(content),
				model,
				status,
				role === "assistant" ? group : null,
				now,
				files.length ? JSON.stringify(files) : null,
			);

	if (turn.user) statements.push(insert(turn.user.id, turn.user.parentId, "user", turn.user.content, "complete", null, turn.user.files));
	statements.push(insert(turn.assistant.id, turn.assistant.parentId, "assistant", "", "streaming", turn.assistant.model));
	for (const sibling of turn.compare?.siblings ?? []) {
		statements.push(insert(sibling.id, turn.assistant.parentId, "assistant", "", "streaming", sibling.model));
	}

	statements.push(
		db
			.prepare(
				`UPDATE conversations SET active_leaf_id = ?3, updated_at = ?4,
					title = CASE WHEN title = '' THEN ?5 ELSE title END
				WHERE id = ?1 AND user_id = ?2`,
			)
			.bind(turn.conversationId, userId, turn.assistant.id, now, turn.titleIfEmpty ?? ""),
	);

	await db.batch(statements);
}

export interface ReplyOutcome {
	content: string;
	reasoning: string;
	status: Exclude<MessageStatus, "streaming">;
	completionTokens: number | null;
}

/**
 * Fill in a streamed reply once it has ended, and make it the conversation's
 * visible leaf. Only a row still marked 'streaming' is written, so a reply is
 * finished exactly once.
 *
 * `activate: false` (compare lanes after the first, M5.4) leaves the active
 * leaf alone: otherwise whichever model finished last would decide what the
 * user sees next, rather than lane 0 or the answer they continue with.
 */
export async function finishReply(
	db: D1Database,
	userId: string,
	conversationId: string,
	messageId: string,
	outcome: ReplyOutcome,
	now = Date.now(),
	activate = true,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`UPDATE messages SET content = ?3, search_text = ?4, reasoning = ?5, status = ?6, completion_tokens = ?7
				WHERE id = ?1 AND user_id = ?2 AND status = 'streaming'`,
			)
			.bind(
				messageId,
				userId,
				outcome.content,
				normalizeForSearch(outcome.content),
				outcome.reasoning || null,
				outcome.status,
				outcome.completionTokens,
			),
		activate
			? db
					.prepare("UPDATE conversations SET active_leaf_id = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2")
					.bind(conversationId, userId, messageId, now)
			: db.prepare("UPDATE conversations SET updated_at = ?3 WHERE id = ?1 AND user_id = ?2").bind(conversationId, userId, now),
	]);
}

export const SEARCH_LIMIT = 20;
const SNIPPET_CHARS = 120;

/** For locating a match in the original text: case, accents and Arabic marks folded. */
function fold(text: string): string {
	return normalizeForSearch(text).normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Plain text around the first match, about SNIPPET_CHARS long. Built here
 * from the content rather than with FTS5's snippet(), which would need the
 * index to store the text and returns markup the client would have to trust.
 *
 * Folding a character at a time keeps a map from folded positions back to
 * the original, so the window is cut from what the user actually wrote.
 */
export function buildSnippet(content: string, query: string): string {
	const terms = normalizeForSearch(query)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
		.map(fold)
		.filter(Boolean);

	let folded = "";
	const origin: number[] = [];
	let offset = 0;
	for (const char of content) {
		const f = fold(char);
		for (let i = 0; i < f.length; i++) origin.push(offset);
		folded += f;
		offset += char.length;
	}

	let at = -1;
	for (const term of terms) {
		const found = folded.indexOf(term);
		if (found >= 0 && (at < 0 || found < at)) at = found;
	}
	const matchStart = at >= 0 ? (origin[at] ?? 0) : 0;

	let start = Math.max(0, matchStart - Math.floor(SNIPPET_CHARS / 3));
	let end = Math.min(content.length, start + SNIPPET_CHARS);
	start = Math.max(0, Math.min(start, end - SNIPPET_CHARS));

	// Avoid cutting a word in half where a space is near.
	if (start > 0) {
		const space = content.indexOf(" ", start);
		if (space >= 0 && space < matchStart && space - start < 20) start = space + 1;
	}
	if (end < content.length) {
		const space = content.lastIndexOf(" ", end);
		if (space > matchStart && end - space < 20) end = space;
	}

	// Never leave half of a surrogate pair (an emoji, say) at either edge.
	if (start > 0 && /[\uDC00-\uDFFF]/.test(content.charAt(start))) start += 1;
	if (end < content.length && /[\uD800-\uDBFF]/.test(content.charAt(end - 1))) end -= 1;

	const text = content.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${text}${end < content.length ? "…" : ""}`;
}

/**
 * The caller's messages matching `query`, newest first, from conversations
 * that are not deleted. Joined back to messages and filtered by user_id, as
 * the schema requires: the FTS table itself knows nothing about owners.
 */
export async function searchMessages(db: D1Database, userId: string, query: string): Promise<SearchHit[]> {
	const match = toMatchQuery(query);
	if (!match) return [];

	const { results } = await db
		.prepare(
			`SELECT m.id, m.conversation_id, m.content, m.created_at, c.title
			FROM messages_fts f
			JOIN messages m ON m.rowid = f.rowid
			JOIN conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
			WHERE messages_fts MATCH ?1 AND m.user_id = ?2 AND c.deleted_at IS NULL
			ORDER BY m.created_at DESC
			LIMIT ?3`,
		)
		.bind(match, userId, SEARCH_LIMIT)
		.all<{ id: string; conversation_id: string; content: string; created_at: number; title: string }>();

	return results.map((row) => ({
		conversationId: row.conversation_id,
		messageId: row.id,
		title: row.title,
		snippet: buildSnippet(row.content, query),
		createdAt: row.created_at,
	}));
}
