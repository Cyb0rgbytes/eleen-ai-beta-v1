/**
 * Text for the model, extracted once at upload time.
 *
 * - Plain text, Markdown and CSV are decoded here; nothing to convert.
 * - PDF and DOCX go through Workers AI Markdown Conversion
 *   (env.AI.toMarkdown), which returns the document as Markdown.
 * - Images go through the same call, which describes them with a Workers AI
 *   vision model. A vision-capable chat model gets the image itself; the
 *   description is what lets every other model answer about it.
 *
 * The stored text is capped; what a single turn may spend on it is decided
 * later, per turn (src/files/context.ts).
 */
import { Env } from "../types";
import type { Sniffed } from "./sniff";
import { decodeText } from "./sniff";

/** Stored extracted text, in characters. A turn uses far less (FILE_CONTEXT_CHARS). */
export const MAX_EXTRACTED_CHARS = 200_000;

/** A document whose text could not be read. Images never throw this. */
export class ExtractionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExtractionError";
	}
}

function cap(text: string): string {
	const trimmed = text.replace(/^﻿/, "").trim();
	return trimmed.length > MAX_EXTRACTED_CHARS ? trimmed.slice(0, MAX_EXTRACTED_CHARS) : trimmed;
}

export async function extractText(env: Env, file: Sniffed, name: string, bytes: Uint8Array): Promise<string | null> {
	if (file.type.startsWith("text/")) {
		const text = decodeText(bytes);
		if (text === null) throw new ExtractionError("not text");
		return cap(text) || null;
	}

	let result: ConversionResponse;
	try {
		result = await env.AI.toMarkdown(
			{ name, blob: new Blob([bytes], { type: file.type }) },
			{ conversionOptions: { pdf: { metadata: false } } },
		);
	} catch (error) {
		console.warn("Markdown conversion failed:", error instanceof Error ? error.message : "unknown");
		if (file.kind === "image") return null;
		throw new ExtractionError("conversion failed");
	}

	if (result.format === "error" || !("data" in result)) {
		if (file.kind === "image") return null;
		throw new ExtractionError("conversion failed");
	}
	const text = cap(result.data);
	if (!text && file.kind === "document") throw new ExtractionError("no text");
	return text || null;
}
