/**
 * Files for one chat turn: the ids the turn names, checked against the
 * caller's own uploads, and, in a saved chat, the files earlier turns of the
 * thread used.
 *
 * Images reach a model in one of two ways, decided by the registry's
 * `vision` flag:
 *   - a vision model gets the image itself, as an image part on the newest
 *     user turn (current turn only, within IMAGE_PART_BYTES);
 *   - every other model gets the description written at upload time, as
 *     untrusted text. No request is refused or rerouted for carrying an
 *     image, so the free models stay usable with pictures.
 */
import { Env } from "../types";
import type { FileRef, UploadedFile } from "../shared/files";
import type { ModelSpec } from "../ai/registry";
import type { ImagePart } from "../ai/providers/types";
import { LoadedFile } from "./context";
import { getFileBytes, getFileMeta, getFileText, toRef } from "./store";

/** Files read for one turn, the thread's included. */
export const MAX_CONTEXT_FILES = 6;

/** Raw image bytes sent as image parts in one turn; images beyond it fall back to their description. */
export const IMAGE_PART_BYTES = 12 * 1024 * 1024;

/** A file id the turn named that is not the caller's, or does not exist. */
export class FileNotFound extends Error {
	constructor() {
		super("File not found");
		this.name = "FileNotFound";
	}
}

export interface TurnFiles {
	loaded: LoadedFile[];
	/** For a vision model: the current turn's images. */
	images: ImagePart[];
	/** The current turn's files, recorded on the saved user message. */
	refs: FileRef[];
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export async function loadTurnFiles(
	env: Env,
	userId: string,
	spec: ModelSpec,
	turnIds: readonly string[],
	threadRefs: readonly FileRef[] = [],
): Promise<TurnFiles> {
	const out: TurnFiles = { loaded: [], images: [], refs: [] };
	if (!turnIds.length && !threadRefs.length) return out;

	// The current turn's files must all exist and be the caller's.
	const current: UploadedFile[] = [];
	for (const id of turnIds) {
		const meta = await getFileMeta(env, userId, id);
		if (!meta) throw new FileNotFound();
		current.push(meta);
	}
	out.refs = current.map(toRef);

	// Earlier turns' files, newest first, that are still there. A file the
	// user deleted since is skipped, not an error.
	const seen = new Set(current.map((f) => f.id));
	const earlier: UploadedFile[] = [];
	for (const ref of threadRefs) {
		if (seen.has(ref.id) || current.length + earlier.length >= MAX_CONTEXT_FILES) continue;
		seen.add(ref.id);
		const meta = await getFileMeta(env, userId, ref.id);
		if (meta) earlier.push(meta);
	}

	let imageBytes = 0;
	// Older files first, so the newest turn's sit closest to the question.
	for (const file of [...earlier.reverse(), ...current]) {
		const isCurrent = current.includes(file);
		if (file.kind === "image" && spec.vision && isCurrent && imageBytes + file.size <= IMAGE_PART_BYTES) {
			const bytes = await getFileBytes(env, userId, file.id);
			if (bytes) {
				imageBytes += bytes.byteLength;
				out.images.push({ mimeType: file.type, data: toBase64(bytes) });
				out.loaded.push({ file, text: null, sentAsImage: true });
				continue;
			}
		}
		out.loaded.push({ file, text: await getFileText(env, userId, file.id) });
	}
	return out;
}
