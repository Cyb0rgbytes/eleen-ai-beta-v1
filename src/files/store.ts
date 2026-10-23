/**
 * Uploaded files in R2 (`eleen-uploads`, binding UPLOADS).
 *
 * Layout, all under the owner's prefix:
 *
 *   u/{userId}/{fileId}        the bytes, with the file's metadata
 *   u/{userId}/{fileId}.txt    text extracted for the model, when there is any
 *
 * The key is built from the authenticated user id and a UUID the server
 * minted, so a lookup can only ever reach the caller's own objects: another
 * user's id simply names a key that does not exist (404, never 403). The
 * bytes are never served back to a browser.
 */
import { Env } from "../types";
import type { FileKind, FileRef, UploadType, UploadedFile } from "../shared/files";
import { UPLOAD_TYPES } from "../shared/files";

function prefix(userId: string): string {
	// Clerk ids are [A-Za-z0-9_]; anything with a separator could reach
	// outside its own prefix, so it is refused rather than escaped.
	if (!/^[\w-]{1,128}$/.test(userId) || userId === "guest") throw new Error("Not a storable user id");
	return `u/${userId}/`;
}
const fileKey = (userId: string, id: string) => `${prefix(userId)}${id}`;
const textKey = (userId: string, id: string) => `${fileKey(userId, id)}.txt`;

/** customMetadata values are strings; the name is percent-encoded to keep it ASCII. */
function toMetadata(file: UploadedFile, createdAt: number): Record<string, string> {
	return {
		name: encodeURIComponent(file.name),
		type: file.type,
		kind: file.kind,
		size: String(file.size),
		chars: String(file.chars ?? 0),
		createdAt: String(createdAt),
	};
}

function fromMetadata(id: string, meta: Record<string, string> | undefined): UploadedFile | null {
	if (!meta) return null;
	const type = meta.type as UploadType;
	if (!(UPLOAD_TYPES as readonly string[]).includes(type)) return null;
	const kind: FileKind = meta.kind === "image" ? "image" : "document";
	let name = "file";
	try {
		name = decodeURIComponent(meta.name ?? "file");
	} catch {
		// A name that does not decode is shown as "file".
	}
	const chars = Number(meta.chars);
	return {
		id,
		name,
		type,
		kind,
		size: Number(meta.size) || 0,
		...(Number.isFinite(chars) && chars > 0 ? { chars } : {}),
	};
}

export function toRef(file: UploadedFile): FileRef {
	return { id: file.id, name: file.name, type: file.type, size: file.size, kind: file.kind };
}

/** Write the bytes and, if any, the extracted text. The text goes first so a file never exists without it. */
export async function putFile(env: Env, userId: string, file: UploadedFile, bytes: Uint8Array, text: string | null): Promise<void> {
	if (text) {
		await env.UPLOADS.put(textKey(userId, file.id), text, {
			httpMetadata: { contentType: "text/plain; charset=utf-8" },
		});
	}
	await env.UPLOADS.put(fileKey(userId, file.id), bytes, {
		httpMetadata: { contentType: file.type },
		customMetadata: toMetadata(file, Date.now()),
	});
}

/** The caller's file, or null. */
export async function getFileMeta(env: Env, userId: string, id: string): Promise<UploadedFile | null> {
	const head = await env.UPLOADS.head(fileKey(userId, id));
	return head ? fromMetadata(id, head.customMetadata) : null;
}

export async function getFileText(env: Env, userId: string, id: string): Promise<string | null> {
	const object = await env.UPLOADS.get(textKey(userId, id));
	return object ? object.text() : null;
}

export async function getFileBytes(env: Env, userId: string, id: string): Promise<ArrayBuffer | null> {
	const object = await env.UPLOADS.get(fileKey(userId, id));
	return object ? object.arrayBuffer() : null;
}

/** Remove one of the caller's files. False when there was none. */
export async function deleteFile(env: Env, userId: string, id: string): Promise<boolean> {
	if (!(await env.UPLOADS.head(fileKey(userId, id)))) return false;
	await env.UPLOADS.delete([fileKey(userId, id), textKey(userId, id)]);
	return true;
}

/** Every object under the caller's prefix, a listing page (up to 1000 keys) at a time. */
export async function deleteAllFiles(env: Env, userId: string): Promise<number> {
	let removed = 0;
	let cursor: string | undefined;
	do {
		const page = await env.UPLOADS.list({ prefix: prefix(userId), cursor });
		const keys = page.objects.map((o) => o.key);
		if (keys.length) await env.UPLOADS.delete(keys);
		removed += keys.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return removed;
}
