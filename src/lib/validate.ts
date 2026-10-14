/**
 * Request body validation.
 *
 * The existing `content-length` checks in src/index.ts are advisory at best: a
 * chunked request omits the header entirely and sails past them. These
 * functions validate the parsed body, which is the only thing that reflects
 * what was actually sent.
 */
import { ChatMessage } from "../types";

export const MAX_MESSAGES = 40;
export const MAX_CONTENT_CHARS = 8000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_B64 = 7 * 1024 * 1024;
export const MAX_PROMPT_CHARS = 2000;
export const MAX_QUERY_CHARS = 1000;

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
	attachments?: unknown[];
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
			body.attachments.slice(0, MAX_ATTACHMENTS).forEach((entry, index) => {
				const attachment = (entry ?? {}) as Record<string, unknown>;
				if (typeof attachment.data !== "string" || !attachment.data) {
					failures.push({ field: `attachments[${index}].data`, message: "must be a string" });
				} else if (attachment.data.length > MAX_ATTACHMENT_B64) {
					failures.push({ field: `attachments[${index}].data`, message: "exceeds the size limit" });
				}
				if (typeof attachment.mimeType !== "string" || !attachment.mimeType) {
					failures.push({
						field: `attachments[${index}].mimeType`,
						message: "must be a string",
					});
				}
			});
		}
	}

	if (body.mode !== undefined && typeof body.mode !== "string") {
		failures.push({ field: "mode", message: "must be a string" });
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
		attachments: body.attachments as unknown[] | undefined,
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
