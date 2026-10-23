/**
 * The file routes (contract in src/shared/files.ts).
 *
 * Signed-in only; the router has already authenticated the caller. Uploads
 * are charged to the `upload` bucket, reads and deletes to `history`. Every
 * lookup goes through the caller's own R2 prefix (src/files/store.ts), so an
 * id that is not theirs is a 404 whether or not it exists.
 */
import { Env } from "../types";
import { MAX_FILE_BYTES, UploadedFile } from "../shared/files";
import { isUuid, sanitizeAttachmentName } from "../lib/validate";
import { sniff } from "../files/sniff";
import { ExtractionError, extractText } from "../files/extract";
import { deleteFile, getFileMeta, putFile } from "../files/store";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function reply(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const notFound = () => reply(404, { error: "Not found." });
const tooLarge = () => reply(413, { error: `Files can be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB.`, reason: "too-large" });

/** Extension handed to the converter, which picks its parser from the name. */
const EXTENSION: Record<string, string> = {
	"application/pdf": "pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/csv": "csv",
};

class TooLarge extends Error {}

/**
 * The body, read with a hard cap. Content-Length is checked first as a fast
 * path, but a chunked body has none, so the stream itself is counted too.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max + 64 * 1024) throw new TooLarge();
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		// Multipart framing adds a little; the file itself is checked again below.
		if (total > max + 64 * 1024) {
			await reader.cancel().catch(() => {});
			throw new TooLarge();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function headerName(request: Request): string {
	const raw = request.headers.get("x-file-name") ?? "";
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** The file's bytes and its client-supplied name, from a raw or multipart body. */
async function readUpload(request: Request): Promise<{ bytes: Uint8Array; name: string } | null> {
	const body = await readCapped(request, MAX_FILE_BYTES);
	const contentType = request.headers.get("content-type") ?? "";
	if (!/^multipart\/form-data/i.test(contentType)) return { bytes: body, name: headerName(request) };

	let form: FormData;
	try {
		form = await new Response(body, { headers: { "content-type": contentType } }).formData();
	} catch {
		return null;
	}
	const file = form.get("file");
	if (!file || typeof file === "string") return null;
	return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
}

async function upload(request: Request, env: Env, userId: string): Promise<Response> {
	let upload: { bytes: Uint8Array; name: string } | null;
	try {
		upload = await readUpload(request);
	} catch (error) {
		if (error instanceof TooLarge) return tooLarge();
		throw error;
	}
	if (!upload) return reply(400, { error: "Send the file as the body, or as a multipart field named file." });
	const { bytes } = upload;
	if (bytes.byteLength === 0) return reply(422, { error: "The file is empty.", reason: "empty" });
	if (bytes.byteLength > MAX_FILE_BYTES) return tooLarge();

	const name = sanitizeAttachmentName(upload.name || "file");
	const sniffed = sniff(bytes, name);
	if (!sniffed) {
		return reply(415, {
			error: "That type of file is not supported. Attach a PDF, Word document, image, or text file.",
			reason: "unsupported-type",
		});
	}

	let text: string | null;
	try {
		text = await extractText(env, sniffed, `file.${EXTENSION[sniffed.type] ?? "bin"}`, bytes);
	} catch (error) {
		if (error instanceof ExtractionError) {
			return reply(422, { error: "No text could be read from this file.", reason: "unreadable" });
		}
		throw error;
	}

	const file: UploadedFile = {
		id: crypto.randomUUID(),
		name,
		type: sniffed.type,
		size: bytes.byteLength,
		kind: sniffed.kind,
		...(text ? { chars: text.length } : {}),
	};
	await putFile(env, userId, file, bytes, text);
	return reply(201, { file });
}

export async function handleFiles(request: Request, env: Env, _ctx: ExecutionContext, userId: string): Promise<Response> {
	try {
		return await upload(request, env, userId);
	} catch (error) {
		// No name, content or id in the log.
		console.error("Upload failed:", error instanceof Error ? error.message : "unknown");
		return reply(500, { error: "Failed to store the file." });
	}
}

export async function handleFile(
	request: Request,
	env: Env,
	_ctx: ExecutionContext,
	userId: string,
	[rawId]: readonly string[],
): Promise<Response> {
	if (!isUuid(rawId)) return notFound();
	const id = rawId.toLowerCase();
	try {
		if (request.method === "DELETE") {
			return (await deleteFile(env, userId, id)) ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } }) : notFound();
		}
		const file = await getFileMeta(env, userId, id);
		return file ? reply(200, { file }) : notFound();
	} catch (error) {
		console.error("File route failed:", error instanceof Error ? error.message : "unknown");
		return reply(500, { error: "Failed to process request" });
	}
}
