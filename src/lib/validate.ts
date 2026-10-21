/**
 * Request body validation.
 *
 * The existing `content-length` checks in src/index.ts are advisory at best: a
 * chunked request omits the header entirely and sails past them. These
 * functions validate the parsed body, which is the only thing that reflects
 * what was actually sent.
 */
import { Attachment, ChatMessage } from "../types";
import { resolveModel } from "../ai/registry";
import { Protocol, isProtocol } from "../ai/sse";

export const MAX_MESSAGES = 40;
export const MAX_CONTENT_CHARS = 8000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_B64 = 7 * 1024 * 1024;
/** All attachments together, in base64 characters (~7.5 MiB decoded). */
export const MAX_TOTAL_ATTACHMENT_B64 = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 128;
export const MAX_PROMPT_CHARS = 2000;
export const MAX_QUERY_CHARS = 1000;

/**
 * Types the attachment path actually knows how to read: images go to vision,
 * everything else is decoded as UTF-8 text. Anything outside this list was
 * previously forwarded to the vision API or decoded as text regardless.
 */
const ALLOWED_ATTACHMENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"text/plain",
	"text/markdown",
	"text/csv",
	"application/json",
]);

/**
 * Reduce a client-supplied file name to something safe to show a model.
 *
 * The name is attacker-controlled text that lands in the prompt, so it loses
 * control and bidi-override characters (which can visually reorder text) and
 * the brackets and quotes that would let it imitate a prompt delimiter.
 */
export function sanitizeAttachmentName(raw: unknown): string {
	if (typeof raw !== "string") return "attachment";
	const cleaned = raw
		.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "")
		.replace(/[<>\[\]{}"'`]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_ATTACHMENT_NAME_CHARS);
	return cleaned || "attachment";
}

const ALLOWED_ROLES = new Set(["user", "assistant"]);

export interface ValidationFailure {
	field: string;
	message: string;
}

export class ValidationError extends Error {
	constructor(public readonly failures: ValidationFailure[]) {
		super(failures.map((f) => `${f.field}: ${f.message}`).join("; "));
		this.name = "ValidationError";
	}
}

/** 422 rather than 400: the body parsed as JSON but is semantically wrong. */
export function validationResponse(error: ValidationError): Response {
	return new Response(
		JSON.stringify({ error: "Invalid request body.", details: error.failures }),
		{ status: 422, headers: { "content-type": "application/json" } },
	);
}

function requireString(
	value: unknown,
	field: string,
	max: number,
	failures: ValidationFailure[],
): string {
	if (typeof value !== "string") {
		failures.push({ field, message: "must be a string" });
		return "";
	}
	const trimmed = value.trim();
	if (!trimmed) {
		failures.push({ field, message: "must not be empty" });
		return "";
	}
	if (value.length > max) {
		failures.push({ field, message: `must be at most ${max} characters` });
		return trimmed.slice(0, max);
	}
	return trimmed;
}

export function validateChatBody(raw: unknown): {
	messages: ChatMessage[];
	mode?: string;
	attachments?: Attachment[];
	/** A registry model id or tier name. Absent means the default model. */
	model?: string;
	/** Stream encoding; absent means the published v1 framing. */
	protocol?: Protocol;
	/** The user asked by voice, so the reply will be read aloud. */
	voice?: boolean;
} {
	const failures: ValidationFailure[] = [];
	const body = (raw ?? {}) as Record<string, unknown>;

	if (!Array.isArray(body.messages)) {
		throw new ValidationError([{ field: "messages", message: "must be an array" }]);
	}
	if (body.messages.length === 0) {
		failures.push({ field: "messages", message: "must not be empty" });
	}
	if (body.messages.length > MAX_MESSAGES) {
		failures.push({ field: "messages", message: `must contain at most ${MAX_MESSAGES} entries` });
	}

	const messages: ChatMessage[] = [];

	body.messages.slice(0, MAX_MESSAGES).forEach((entry, index) => {
		const message = (entry ?? {}) as Record<string, unknown>;
		const role = message.role;

		// A client-supplied system message is dropped rather than rejected: the
		// handler unconditionally prepends the real system prompt anyway, so
		// silently discarding it is both safe and kinder to older clients.
		if (role === "system") return;

		if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
			failures.push({
				field: `messages[${index}].role`,
				message: 'must be "user" or "assistant"',
			});
			return;
		}
		if (typeof message.content !== "string") {
			failures.push({ field: `messages[${index}].content`, message: "must be a string" });
			return;
		}
		if (message.content.length > MAX_CONTENT_CHARS) {
			failures.push({
				field: `messages[${index}].content`,
				message: `must be at most ${MAX_CONTENT_CHARS} characters`,
			});
			return;
		}

		messages.push({ role: role as ChatMessage["role"], content: message.content });
	});

	const attachments: Attachment[] = [];

	if (body.attachments !== undefined) {
		if (!Array.isArray(body.attachments)) {
			failures.push({ field: "attachments", message: "must be an array" });
		} else {
			if (body.attachments.length > MAX_ATTACHMENTS) {
				failures.push({
					field: "attachments",
					message: `must contain at most ${MAX_ATTACHMENTS} entries`,
				});
			}
			let totalSize = 0;
			body.attachments.slice(0, MAX_ATTACHMENTS).forEach((entry, index) => {
				const attachment = (entry ?? {}) as Record<string, unknown>;
				const data = attachment.data;
				const mimeType = attachment.mimeType;
				let valid = true;

				if (typeof data !== "string" || !data) {
					failures.push({ field: `attachments[${index}].data`, message: "must be a string" });
					valid = false;
				} else if (data.length > MAX_ATTACHMENT_B64) {
					failures.push({ field: `attachments[${index}].data`, message: "exceeds the size limit" });
					valid = false;
				} else {
					totalSize += data.length;
				}

				if (typeof mimeType !== "string" || !mimeType) {
					failures.push({
						field: `attachments[${index}].mimeType`,
						message: "must be a string",
					});
					valid = false;
				} else if (!ALLOWED_ATTACHMENT_TYPES.has(mimeType.toLowerCase())) {
					failures.push({
						field: `attachments[${index}].mimeType`,
						message: "is not a supported file type",
					});
					valid = false;
				}

				if (valid) {
					attachments.push({
						data: data as string,
						mimeType: (mimeType as string).toLowerCase(),
						name: sanitizeAttachmentName(attachment.name),
					});
				}
			});
			if (totalSize > MAX_TOTAL_ATTACHMENT_B64) {
				failures.push({ field: "attachments", message: "exceed the total size limit" });
			}
		}
	}

	if (body.mode !== undefined && typeof body.mode !== "string") {
		failures.push({ field: "mode", message: "must be a string" });
	}

	// An unknown model is refused here rather than forwarded: the registry is
	// the only source of ids a provider will ever be asked for.
	if (body.model !== undefined) {
		if (typeof body.model !== "string") {
			failures.push({ field: "model", message: "must be a string" });
		} else if (body.model !== "" && resolveModel(body.model) === null) {
			failures.push({ field: "model", message: "is not a known model or tier" });
		}
	}

	if (body.protocol !== undefined && !isProtocol(body.protocol)) {
		failures.push({ field: "protocol", message: "must be 1 or 2" });
	}

	if (body.voice !== undefined && typeof body.voice !== "boolean") {
		failures.push({ field: "voice", message: "must be a boolean" });
	}

	if (failures.length) throw new ValidationError(failures);
	if (!messages.length) {
		throw new ValidationError([
			{ field: "messages", message: "must contain at least one user or assistant message" },
		]);
	}

	return {
		messages,
		mode: body.mode as string | undefined,
		attachments: body.attachments === undefined ? undefined : attachments,
		model: typeof body.model === "string" && body.model !== "" ? body.model : undefined,
		protocol: isProtocol(body.protocol) ? body.protocol : undefined,
		voice: body.voice === true ? true : undefined,
	};
}

export function validatePrompt(raw: unknown, field = "prompt", max = MAX_PROMPT_CHARS): string {
	const failures: ValidationFailure[] = [];
	const body = (raw ?? {}) as Record<string, unknown>;
	const value = requireString(body[field], field, max, failures);
	if (failures.length) throw new ValidationError(failures);
	return value;
}

export function validateVisionBody(raw: unknown): {
	image: string;
	mimeType: string;
	question?: string;
} {
	const failures: ValidationFailure[] = [];
	const body = (raw ?? {}) as Record<string, unknown>;

	const image = typeof body.image === "string" ? body.image : "";
	if (!image) failures.push({ field: "image", message: "must be a base64 string" });
	else if (image.length > MAX_ATTACHMENT_B64) {
		failures.push({ field: "image", message: "exceeds the size limit" });
	}

	const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
	if (!mimeType) failures.push({ field: "mimeType", message: "is required" });
	else if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
		failures.push({ field: "mimeType", message: "must be an image media type" });
	}

	if (body.question !== undefined && typeof body.question !== "string") {
		failures.push({ field: "question", message: "must be a string" });
	}
	if (typeof body.question === "string" && body.question.length > MAX_CONTENT_CHARS) {
		failures.push({ field: "question", message: `must be at most ${MAX_CONTENT_CHARS} characters` });
	}

	if (failures.length) throw new ValidationError(failures);

	return {
		image,
		mimeType,
		question: typeof body.question === "string" ? body.question : undefined,
	};
}
