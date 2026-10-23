/**
 * The browser's side of saved conversations, folders and search (M4.3/M4.4),
 * against the contract in src/shared/history.ts.
 *
 * Every route is signed-in only. Everything read from the wire is checked
 * field by field before the UI sees it: titles, snippets and message text
 * are user or model text, so they reach the page as strings and nothing else.
 */
import type {
	ConversationDetail,
	ConversationList,
	ConversationSummary,
	ConversationUpdate,
	DeletedConversation,
	DeletedConversationList,
	Folder,
	MessageStatus,
	SearchHit,
	StoredMessage,
} from "../../../src/shared/history";
import { ApiError, request } from "../api/client";
import { UPLOAD_TYPES, type FileRef } from "../../../src/shared/files";

const TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
	return Array.isArray(value) ? value.map(parse).filter((item): item is T => item !== null) : [];
}

export function parseSummary(value: unknown): ConversationSummary | null {
	const c = record(value);
	if (!c || !id(c.id)) return null;
	return {
		id: c.id,
		title: str(c.title),
		pinned: c.pinned === true,
		folderId: strOrNull(c.folderId),
		createdAt: num(c.createdAt),
		updatedAt: num(c.updatedAt),
	};
}

const STATUSES: readonly MessageStatus[] = ["streaming", "complete", "stopped", "error"];

/** An attachment on a user turn (M5.2). Its type must be one the server accepts. */
function parseFileRef(value: unknown): FileRef | null {
	const f = record(value);
	if (!f || !id(f.id) || !(UPLOAD_TYPES as readonly unknown[]).includes(f.type)) return null;
	return { id: f.id, name: str(f.name), type: f.type as FileRef["type"], size: num(f.size), kind: f.kind === "image" ? "image" : "document" };
}

export function parseMessage(value: unknown): StoredMessage | null {
	const m = record(value);
	if (!m || !id(m.id) || (m.role !== "user" && m.role !== "assistant")) return null;
	const files = list(m.files, parseFileRef);
	return {
		id: m.id,
		parentId: strOrNull(m.parentId),
		seq: num(m.seq),
		role: m.role,
		content: str(m.content),
		reasoning: strOrNull(m.reasoning),
		model: strOrNull(m.model),
		status: STATUSES.includes(m.status as MessageStatus) ? (m.status as MessageStatus) : "complete",
		compareGroup: strOrNull(m.compareGroup),
		completionTokens: typeof m.completionTokens === "number" ? m.completionTokens : null,
		createdAt: num(m.createdAt),
		...(files.length ? { files } : {}),
	};
}

function parseFolder(value: unknown): Folder | null {
	const f = record(value);
	if (!f || !id(f.id)) return null;
	return { id: f.id, name: str(f.name), position: num(f.position) };
}

function parseHit(value: unknown): SearchHit | null {
	const h = record(value);
	if (!h || !id(h.conversationId) || !id(h.messageId)) return null;
	return {
		conversationId: h.conversationId,
		messageId: h.messageId,
		title: str(h.title),
		snippet: str(h.snippet),
		createdAt: num(h.createdAt),
	};
}

async function json(path: string, init: Parameters<typeof request>[1] = {}): Promise<Json> {
	const response = await request(path, { auth: true, timeoutMs: TIMEOUT_MS, ...init });
	return record(await response.json()) ?? {};
}

function conversationOf(body: Json): ConversationSummary {
	const conversation = parseSummary(body.conversation);
	if (!conversation) throw new ApiError("server", "The server sent no conversation.");
	return conversation;
}

const path = (base: string, value: string) => `${base}/${encodeURIComponent(value)}`;

// ─── Conversations ───────────────────────────────────────────────────────────

export async function listConversations(
	options: { folder?: string; cursor?: string | null; signal?: AbortSignal } = {},
): Promise<ConversationList> {
	const query: Record<string, string> = {};
	if (options.folder) query.folder = options.folder;
	if (options.cursor) query.cursor = options.cursor;
	const body = await json("/api/v1/conversations", { query, signal: options.signal });
	return { conversations: list(body.conversations, parseSummary), nextCursor: strOrNull(body.nextCursor) };
}

export async function getConversation(conversationId: string, signal?: AbortSignal): Promise<ConversationDetail> {
	const body = await json(path("/api/v1/conversations", conversationId), { signal });
	const summary = parseSummary(body.conversation);
	if (!summary) throw new ApiError("server", "The server sent no conversation.");
	const activeLeafId = strOrNull(record(body.conversation)?.activeLeafId);
	return { conversation: { ...summary, activeLeafId }, messages: list(body.messages, parseMessage) };
}

export async function createConversation(title?: string): Promise<ConversationSummary> {
	return conversationOf(await json("/api/v1/conversations", { method: "POST", body: title === undefined ? {} : { title } }));
}

export async function patchConversation(conversationId: string, update: ConversationUpdate): Promise<ConversationSummary> {
	return conversationOf(await json(path("/api/v1/conversations", conversationId), { method: "PATCH", body: update }));
}

/** Soft delete; restoreConversation undoes it. */
export async function deleteConversation(conversationId: string): Promise<void> {
	await request(path("/api/v1/conversations", conversationId), { method: "DELETE", auth: true, timeoutMs: TIMEOUT_MS });
}

export async function restoreConversation(conversationId: string): Promise<ConversationSummary> {
	return conversationOf(await json(`${path("/api/v1/conversations", conversationId)}/restore`, { method: "POST" }));
}

function parseDeleted(value: unknown): DeletedConversation | null {
	const summary = parseSummary(value);
	return summary ? { ...summary, deletedAt: num(record(value)?.deletedAt) } : null;
}

/** Recently deleted: still restorable, most recently deleted first. */
export async function listDeletedConversations(
	options: { cursor?: string | null; signal?: AbortSignal } = {},
): Promise<DeletedConversationList> {
	const query: Record<string, string> = { deleted: "1" };
	if (options.cursor) query.cursor = options.cursor;
	const body = await json("/api/v1/conversations", { query, signal: options.signal });
	return { conversations: list(body.conversations, parseDeleted), nextCursor: strOrNull(body.nextCursor) };
}

/** For good: no undo. */
export async function purgeConversation(conversationId: string): Promise<void> {
	await request(path("/api/v1/conversations", conversationId), {
		method: "DELETE",
		auth: true,
		timeoutMs: TIMEOUT_MS,
		query: { purge: "1" },
	});
}

// ─── Folders ─────────────────────────────────────────────────────────────────

export async function listFolders(signal?: AbortSignal): Promise<Folder[]> {
	return list((await json("/api/v1/folders", { signal })).folders, parseFolder);
}

function folderOf(body: Json): Folder {
	const folder = parseFolder(body.folder);
	if (!folder) throw new ApiError("server", "The server sent no folder.");
	return folder;
}

export async function createFolder(name: string): Promise<Folder> {
	return folderOf(await json("/api/v1/folders", { method: "POST", body: { name } }));
}

export async function patchFolder(folderId: string, update: { name?: string; position?: number }): Promise<Folder> {
	return folderOf(await json(path("/api/v1/folders", folderId), { method: "PATCH", body: update }));
}

/** Its conversations move back to no folder. */
export async function deleteFolder(folderId: string): Promise<void> {
	await request(path("/api/v1/folders", folderId), { method: "DELETE", auth: true, timeoutMs: TIMEOUT_MS });
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function search(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
	return list((await json("/api/v1/search", { query: { q }, signal })).results, parseHit);
}
