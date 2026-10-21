/**
 * The Phase 4 REST routes: conversations, folders, search, consent and memory
 * (contract in src/shared/history.ts).
 *
 * All signed-in only; the router has already authenticated the caller and
 * charged the `history` bucket. Every handler acts on the caller's rows
 * alone, and an id that is not theirs is a 404 whether or not it exists.
 *
 * Responses are never cached: they are one user's private data.
 */
import { Env } from "../types";
import { ensureAccount } from "../chat/memory";
import { getConsent, putConsent } from "../db/consent";
import {
	MAX_TITLE_CHARS,
	createConversation,
	decodeCursor,
	deleteAllConversations,
	deleteConversation,
	getConversation,
	getConversationDetail,
	listConversations,
	updateConversation,
} from "../db/conversations";
import { createFolder, deleteFolder, folderExists, listFolders, updateFolder } from "../db/folders";
import { deleteAllMemory, deleteMemoryEntry, listMemory } from "../db/memory";
import { getMessageRef, searchMessages } from "../db/messages";
import { ValidationError, ValidationFailure, isUuid, validationResponse } from "../lib/validate";
import { POLICY_VERSION } from "../shared/history";
import type { ConversationPatch } from "../db/conversations";

export const MAX_FOLDER_NAME_CHARS = 80;
export const MAX_SEARCH_CHARS = 200;
const MAX_FOLDER_POSITION = 100_000;

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function reply(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const notFound = () => reply(404, { error: "Not found." });

class BadJson extends Error {}

/** The JSON object body. `optional` lets an empty body stand for {}. */
async function readBody(request: Request, optional = false): Promise<Record<string, unknown>> {
	const raw = await request.text();
	if (optional && !raw.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new BadJson();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadJson();
	return parsed as Record<string, unknown>;
}

/** A title or name: trimmed, within limits. */
function text(
	value: unknown,
	field: string,
	limits: { min: number; max: number },
	failures: ValidationFailure[],
): string | undefined {
	if (typeof value !== "string") {
		failures.push({ field, message: "must be a string" });
		return undefined;
	}
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (trimmed.length < limits.min) {
		failures.push({ field, message: "must not be empty" });
		return undefined;
	}
	if (trimmed.length > limits.max) {
		failures.push({ field, message: `must be at most ${limits.max} characters` });
		return undefined;
	}
	return trimmed;
}

type Handler = (request: Request, env: Env, ctx: ExecutionContext, userId: string, params: readonly string[]) => Promise<Response>;

/**
 * Shared wrapper: the users row first (the foreign keys need it), then the
 * handler, with body and validation errors mapped to 400 and 422. Logs carry
 * no ids or content, only that a route failed.
 */
function historyRoute(handler: Handler): Handler {
	return async (request, env, ctx, userId, params) => {
		try {
			await ensureAccount(env, ctx, userId);
			return await handler(request, env, ctx, userId, params);
		} catch (error) {
			if (error instanceof BadJson) return reply(400, { error: "Body must be a JSON object." });
			if (error instanceof ValidationError) return validationResponse(error);
			console.error("History route failed:", error instanceof Error ? error.message : "unknown");
			return reply(500, { error: "Failed to process request" });
		}
	};
}

// ─── Consent ─────────────────────────────────────────────────────────────────

export const handleConsent = historyRoute(async (request, env, _ctx, userId) => {
	if (request.method === "GET") {
		return reply(200, { consent: await getConsent(env.DB, userId), policyVersion: POLICY_VERSION });
	}

	const body = await readBody(request);
	const failures: ValidationFailure[] = [];
	for (const field of ["history", "memory"] as const) {
		if (typeof body[field] !== "boolean") failures.push({ field, message: "must be a boolean" });
	}
	if (failures.length) throw new ValidationError(failures);

	const consent = await putConsent(env.DB, userId, { history: body.history as boolean, memory: body.memory as boolean });
	return reply(200, { consent, policyVersion: POLICY_VERSION });
});

// ─── Memory ──────────────────────────────────────────────────────────────────

export const handleMemory = historyRoute(async (request, env, _ctx, userId) => {
	if (request.method === "GET") return reply(200, { entries: await listMemory(env.DB, userId) });
	await deleteAllMemory(env.DB, userId);
	return noContent();
});

export const handleMemoryEntry = historyRoute(async (_request, env, _ctx, userId, [id]) => {
	if (!isUuid(id) || !(await deleteMemoryEntry(env.DB, userId, id.toLowerCase()))) return notFound();
	return noContent();
});

// ─── Conversations ───────────────────────────────────────────────────────────

export const handleConversations = historyRoute(async (request, env, _ctx, userId) => {
	if (request.method === "GET") {
		const url = new URL(request.url);
		const failures: ValidationFailure[] = [];

		const folder = url.searchParams.get("folder") ?? undefined;
		if (folder !== undefined && folder !== "none" && !isUuid(folder)) {
			failures.push({ field: "folder", message: 'must be a folder id or "none"' });
		}
		const rawCursor = url.searchParams.get("cursor");
		const cursor = rawCursor ? decodeCursor(rawCursor) : null;
		if (rawCursor && !cursor) failures.push({ field: "cursor", message: "is not a cursor from this API" });
		if (failures.length) throw new ValidationError(failures);

		return reply(
			200,
			await listConversations(env.DB, userId, { folder: folder === "none" ? folder : folder?.toLowerCase(), cursor }),
		);
	}

	if (request.method === "DELETE") {
		await deleteAllConversations(env.DB, userId);
		return noContent();
	}

	// POST. An empty body is a conversation with no title yet.
	const body = await readBody(request, true);
	const failures: ValidationFailure[] = [];
	const title = body.title === undefined ? "" : text(body.title, "title", { min: 0, max: MAX_TITLE_CHARS }, failures);
	if (failures.length) throw new ValidationError(failures);

	return reply(201, { conversation: await createConversation(env.DB, userId, title ?? "") });
});

export const handleConversation = historyRoute(async (request, env, _ctx, userId, [rawId]) => {
	if (!isUuid(rawId)) return notFound();
	const id = rawId.toLowerCase();

	if (request.method === "GET") {
		const detail = await getConversationDetail(env.DB, userId, id);
		return detail ? reply(200, detail) : notFound();
	}

	if (request.method === "DELETE") {
		const purge = new URL(request.url).searchParams.get("purge") === "1";
		return (await deleteConversation(env.DB, userId, id, purge)) ? noContent() : notFound();
	}

	// PATCH
	const body = await readBody(request);
	const failures: ValidationFailure[] = [];
	const patch: ConversationPatch = {};

	if (body.title !== undefined) patch.title = text(body.title, "title", { min: 0, max: MAX_TITLE_CHARS }, failures);
	if (body.pinned !== undefined) {
		if (typeof body.pinned !== "boolean") failures.push({ field: "pinned", message: "must be a boolean" });
		else patch.pinned = body.pinned;
	}
	if (body.folderId !== undefined) {
		if (body.folderId !== null && !isUuid(body.folderId)) {
			failures.push({ field: "folderId", message: "must be a folder id or null" });
		} else {
			patch.folderId = body.folderId === null ? null : body.folderId.toLowerCase();
		}
	}
	if (body.activeLeafId !== undefined) {
		if (!isUuid(body.activeLeafId)) failures.push({ field: "activeLeafId", message: "must be a message id" });
		else patch.activeLeafId = body.activeLeafId.toLowerCase();
	}
	if (failures.length) throw new ValidationError(failures);

	// Every id in the patch must be the caller's; any that is not makes the
	// whole request a 404, so a probe learns nothing about which part missed.
	if (!(await getConversation(env.DB, userId, id))) return notFound();
	if (patch.folderId && !(await folderExists(env.DB, userId, patch.folderId))) return notFound();
	if (patch.activeLeafId && !(await getMessageRef(env.DB, userId, id, patch.activeLeafId))) return notFound();

	const conversation = await updateConversation(env.DB, userId, id, patch);
	return conversation ? reply(200, { conversation }) : notFound();
});

// ─── Folders ─────────────────────────────────────────────────────────────────

export const handleFolders = historyRoute(async (request, env, _ctx, userId) => {
	if (request.method === "GET") return reply(200, { folders: await listFolders(env.DB, userId) });

	const body = await readBody(request);
	const failures: ValidationFailure[] = [];
	const name = text(body.name, "name", { min: 1, max: MAX_FOLDER_NAME_CHARS }, failures);
	if (failures.length || name === undefined) throw new ValidationError(failures);

	return reply(201, { folder: await createFolder(env.DB, userId, name) });
});

export const handleFolder = historyRoute(async (request, env, _ctx, userId, [rawId]) => {
	if (!isUuid(rawId)) return notFound();
	const id = rawId.toLowerCase();

	if (request.method === "DELETE") {
		return (await deleteFolder(env.DB, userId, id)) ? noContent() : notFound();
	}

	// PATCH
	const body = await readBody(request);
	const failures: ValidationFailure[] = [];
	const patch: { name?: string; position?: number } = {};
	if (body.name !== undefined) patch.name = text(body.name, "name", { min: 1, max: MAX_FOLDER_NAME_CHARS }, failures);
	if (body.position !== undefined) {
		const position = body.position;
		if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position > MAX_FOLDER_POSITION) {
			failures.push({ field: "position", message: `must be an integer from 0 to ${MAX_FOLDER_POSITION}` });
		} else {
			patch.position = position;
		}
	}
	if (failures.length) throw new ValidationError(failures);

	const folder = await updateFolder(env.DB, userId, id, patch);
	return folder ? reply(200, { folder }) : notFound();
});

// ─── Search ──────────────────────────────────────────────────────────────────

export const handleSearch = historyRoute(async (request, env, _ctx, userId) => {
	const q = new URL(request.url).searchParams.get("q") ?? "";
	const failures: ValidationFailure[] = [];
	if (!q.trim()) failures.push({ field: "q", message: "must not be empty" });
	if (q.length > MAX_SEARCH_CHARS) failures.push({ field: "q", message: `must be at most ${MAX_SEARCH_CHARS} characters` });
	if (failures.length) throw new ValidationError(failures);

	return reply(200, { results: await searchMessages(env.DB, userId, q) });
});
