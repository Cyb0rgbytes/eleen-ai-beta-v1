/**
 * Conversation export (M5.3): the Markdown and JSON renditions, as pure
 * functions of an ExportConversation. Everything is built in the browser;
 * nothing here touches the DOM or the network.
 *
 * JSON shape, version 1 (`EXPORT_VERSION`). A consumer should check
 * `version` and ignore fields it does not know.
 *
 *   {
 *     "version": 1,
 *     "title": "Tea brewing guide",
 *     "exportedAt": "2026-10-23T18:04:05.000Z",        // ISO 8601, UTC
 *     "messages": [                                     // the visible thread, oldest first
 *       { "role": "user", "content": "...", "createdAt": "2026-10-23T18:00:00.000Z" },
 *       { "role": "assistant", "content": "...", "model": "@cf/...", "createdAt": "..." }
 *     ],
 *     "tree": {                                         // only in a full-tree export of a saved chat
 *       "activeLeafId": "m4",
 *       "messages": [ { "id", "parentId", "role", "content", "model"?, "createdAt"?, "status" } ]
 *     }
 *   }
 *
 * `model` and `createdAt` are present only when known: a guest chat lives
 * in the page and has neither. `content` is the message text exactly as
 * stored: Markdown for replies, plain text for the user's turns. `tree`
 * holds every branch (edits and regenerations); `messages` is the branch
 * that was on screen, the same one the Markdown export contains.
 */

export const EXPORT_VERSION = 1;

export interface ExportMessage {
	role: "user" | "assistant";
	content: string;
	model?: string | null;
	/** Epoch milliseconds. */
	createdAt?: number | null;
}

export interface ExportTreeMessage extends ExportMessage {
	id: string;
	parentId: string | null;
	status?: string;
}

export interface ExportConversation {
	title: string;
	messages: ExportMessage[];
	/** Every branch of a saved chat, for the full-tree JSON. */
	tree?: { activeLeafId: string | null; messages: ExportTreeMessage[] };
}

export interface ExportLabels {
	user: string;
	assistant: string;
	/** "Exported from EleenAI on {date}". */
	exported: string;
	untitled: string;
}

export const DEFAULT_LABELS: ExportLabels = {
	user: "You",
	assistant: "EleenAI",
	exported: "Exported from EleenAI on {date}",
	untitled: "Untitled chat",
};

const iso = (ms: number | null | undefined): string | undefined =>
	typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;

/** One line, no control characters, no runs of whitespace. */
export function cleanTitle(title: string, fallback: string): string {
	const line = title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return line || fallback;
}

/** Backslash-escape what Markdown would read as syntax in a heading line. */
export function escapeMarkdownInline(text: string): string {
	return text.replace(/[\\`*_{}[\]<>()#+!|~]/g, "\\$&").replace(/^(\d+)\./, "$1\\.").replace(/^-/, "\\-");
}

/**
 * Close a code fence the text leaves open (a reply stopped mid-block), so
 * the rest of the document is not swallowed into it. Fences follow
 * CommonMark: three or more backticks or tildes, indented at most three
 * spaces; a closing fence uses the same character, at least as long.
 */
export function balanceFences(text: string): string {
	let open: { char: string; length: number } | null = null;
	for (const line of text.split("\n")) {
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!match) continue;
		const fence = match[1] ?? "";
		const rest = match[2] ?? "";
		const char = fence.charAt(0);
		if (!open) {
			// A backtick fence's info string may not contain a backtick.
			if (char === "`" && rest.includes("`")) continue;
			open = { char, length: fence.length };
		} else if (char === open.char && fence.length >= open.length && rest.trim() === "") {
			open = null;
		}
	}
	if (!open) return text;
	return `${text.replace(/\n*$/, "")}\n${open.char.repeat(open.length)}`;
}

function dateLine(exportedAt: Date, lang: string): string {
	try {
		return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short" }).format(exportedAt);
	} catch {
		return exportedAt.toISOString();
	}
}

/**
 * The conversation as a Markdown document: a title, the export date, then
 * each turn under a bold speaker line, separated by rules. Message text is
 * kept as it was written, Arabic and code included; only an unclosed code
 * fence is closed.
 */
export function buildMarkdown(
	conversation: ExportConversation,
	options: { exportedAt?: Date; labels?: ExportLabels; lang?: string } = {},
): string {
	const labels = options.labels ?? DEFAULT_LABELS;
	const exportedAt = options.exportedAt ?? new Date();
	const title = cleanTitle(conversation.title, labels.untitled);
	const out: string[] = [
		`# ${escapeMarkdownInline(title)}`,
		"",
		`_${labels.exported.replace("{date}", dateLine(exportedAt, options.lang ?? "en"))}_`,
	];
	for (const message of conversation.messages) {
		const speaker = message.role === "user" ? labels.user : labels.assistant;
		const body = balanceFences(message.content.replace(/\r\n?/g, "\n")).replace(/\s+$/, "");
		out.push("", "---", "", `**${speaker}**`, "", body);
	}
	return `${out.join("\n")}\n`;
}

function exportMessage(message: ExportMessage): Record<string, unknown> {
	const out: Record<string, unknown> = { role: message.role, content: message.content };
	if (message.model) out.model = message.model;
	const created = iso(message.createdAt);
	if (created) out.createdAt = created;
	return out;
}

/** The documented, versioned JSON (see the comment at the top). */
export function buildJson(
	conversation: ExportConversation,
	options: { exportedAt?: Date; includeTree?: boolean; untitled?: string } = {},
): string {
	const body: Record<string, unknown> = {
		version: EXPORT_VERSION,
		title: cleanTitle(conversation.title, options.untitled ?? DEFAULT_LABELS.untitled),
		exportedAt: (options.exportedAt ?? new Date()).toISOString(),
		messages: conversation.messages.map(exportMessage),
	};
	if (options.includeTree && conversation.tree) {
		body.tree = {
			activeLeafId: conversation.tree.activeLeafId,
			messages: conversation.tree.messages.map((m) => ({
				id: m.id,
				parentId: m.parentId,
				...exportMessage(m),
				...(m.status ? { status: m.status } : {}),
			})),
		};
	}
	return `${JSON.stringify(body, null, 2)}\n`;
}

const MAX_SLUG = 60;

/**
 * A safe file name: "eleenai-<title>-<yyyy-mm-dd>.<ext>". The title keeps
 * letters and digits in any script (an Arabic title stays Arabic) and loses
 * path separators, characters Windows forbids, control and bidi-override
 * characters, and leading or trailing dots.
 */
export function exportFilename(title: string, ext: "md" | "json", date: Date = new Date()): string {
	const slug =
		title
			.normalize("NFC")
					.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
			.replace(/[<>:"/\\|?*\u0060'$%&{}[\]^=;,!@#+~]/g, " ")
			.replace(/[^\p{L}\p{N}\p{M} ._-]/gu, " ")
			.trim()
			.replace(/\s+/g, "-")
			.replace(/-{2,}/g, "-")
			.slice(0, MAX_SLUG)
			.replace(/^[.\-_]+|[.\-_]+$/g, "")
			.toLowerCase() || "chat";
	const day = date.toISOString().slice(0, 10);
	return `eleenai-${slug}-${day}.${ext}`;
}
