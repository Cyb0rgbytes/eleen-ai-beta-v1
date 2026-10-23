/**
 * File uploads (M5.2): the contract both ends agree on.
 *
 *   POST   /api/v1/files       raw bytes (x-file-name: <percent-encoded name>)
 *                              or multipart/form-data with a `file` field
 *                              -> 201 { file: UploadedFile }
 *   GET    /api/v1/files/:id   -> { file: UploadedFile }, metadata only
 *   DELETE /api/v1/files/:id   -> 204
 *
 * Signed-in only. A file is stored privately under the caller's account and
 * is never served back: there is no route that returns its bytes. Another
 * user's id, or an unknown one, is always 404.
 *
 * A chat turn references uploaded files by id (ChatRequestBody.files). The
 * server reads their extracted text (documents) or the image itself, checks
 * every id belongs to the caller, and hands the contents to the model as
 * untrusted data.
 */

/** Whole upload, in bytes. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Files one chat turn may reference. */
export const MAX_FILES_PER_TURN = 4;

export type FileKind = "document" | "image";

/**
 * Types the server accepts, decided by sniffing the bytes, never by the
 * client's Content-Type or the file name alone (the name only tells the text
 * subtypes apart).
 */
export const UPLOAD_TYPES = [
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"text/plain",
	"text/markdown",
	"text/csv",
] as const;

export type UploadType = (typeof UPLOAD_TYPES)[number];

export interface UploadedFile {
	id: string;
	/** Sanitised display name. */
	name: string;
	type: UploadType;
	/** Bytes. */
	size: number;
	kind: FileKind;
	/** Characters of text extracted for the model (a document's text, an image's description). */
	chars?: number;
}

/** What a saved user turn records about each file it used: enough to draw its chip. */
export type FileRef = Pick<UploadedFile, "id" | "name" | "type" | "size" | "kind">;
