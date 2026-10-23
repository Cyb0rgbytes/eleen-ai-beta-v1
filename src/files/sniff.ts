/**
 * What an upload really is, from its bytes.
 *
 * The client's Content-Type and the file's extension are claims; these
 * checks are not. Binary formats are recognised by their magic bytes, a
 * DOCX by being a zip that contains word/ parts, and text by decoding as
 * strict UTF-8 with no binary control bytes. Anything else is refused.
 * The name is consulted only to tell the text subtypes apart, which no
 * signature can.
 */
import type { FileKind, UploadType } from "../shared/files";

export interface Sniffed {
	type: UploadType;
	kind: FileKind;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
	if (bytes.length < offset + signature.length) return false;
	return signature.every((b, i) => bytes[offset + i] === b);
}

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

const PDF = ascii("%PDF-");
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** Whether `needle` occurs in `bytes` (a plain scan; uploads are at most 10 MB). */
function contains(bytes: Uint8Array, needle: readonly number[]): boolean {
	const first = needle[0];
	outer: for (let i = bytes.indexOf(first as number); i >= 0 && i <= bytes.length - needle.length; i = bytes.indexOf(first as number, i + 1)) {
		for (let j = 1; j < needle.length; j++) {
			if (bytes[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

/**
 * A Word document is a zip (OOXML) whose parts include [Content_Types].xml
 * and word/document.xml. Zip entry names are stored uncompressed, so they
 * can be found in the bytes without inflating anything.
 */
function isDocx(bytes: Uint8Array): boolean {
	return startsWith(bytes, ZIP) && contains(bytes, ascii("[Content_Types].xml")) && contains(bytes, ascii("word/document.xml"));
}

/**
 * Text: strict UTF-8 (a BOM is allowed), and no NUL or other C0 control
 * bytes besides tab, newline, carriage return and form feed. That rules out
 * every binary format, including the ones whose header happens to be ASCII.
 */
export function decodeText(bytes: Uint8Array): string | null {
	for (const b of bytes) {
		if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) return null;
		if (b === 0x7f) return null;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
}

function textSubtype(name: string): UploadType {
	const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
	if (ext === "md" || ext === "markdown") return "text/markdown";
	if (ext === "csv") return "text/csv";
	return "text/plain";
}

export function sniff(bytes: Uint8Array, name: string): Sniffed | null {
	if (bytes.length === 0) return null;
	if (startsWith(bytes, PDF)) return { type: "application/pdf", kind: "document" };
	if (startsWith(bytes, PNG)) return { type: "image/png", kind: "image" };
	if (startsWith(bytes, JPEG)) return { type: "image/jpeg", kind: "image" };
	if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return { type: "image/gif", kind: "image" };
	if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return { type: "image/webp", kind: "image" };
	if (startsWith(bytes, ZIP)) {
		return isDocx(bytes) ? { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" } : null;
	}
	if (decodeText(bytes) !== null) return { type: textSubtype(name), kind: "document" };
	return null;
}
