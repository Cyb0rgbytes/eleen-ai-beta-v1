/**
 * The export actions (M5.3), loaded on first use so the builders stay out
 * of the initial bundle. Files are made in the browser and handed over as a
 * Blob through <a download>; nothing is uploaded anywhere.
 *
 * "Print / Save as PDF" prints the page itself: styles/print.css hides
 * everything but the conversation and switches to print colours. A heading
 * with the title and date is added for the print and removed afterwards.
 */
import { currentLang, t } from "../i18n";
import { showToast } from "../ui/toast";
import { buildJson, buildMarkdown, exportFilename, type ExportConversation, type ExportLabels } from "./format";
import { currentConversation, savedConversation } from "./source";

export type ExportFormat = "md" | "json" | "json-tree";

export interface CurrentChat {
	history(): { role: "system" | "user" | "assistant"; content: string }[];
}

function labels(): ExportLabels {
	return {
		user: t("exportYou"),
		assistant: t("exportAssistant"),
		exported: t("exportedOn"),
		untitled: t("untitledChat"),
	};
}

/** Hand a file to the browser's download manager. */
export function download(filename: string, text: string, type: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.hidden = true;
	document.body.append(a);
	a.click();
	a.remove();
	// Revoked later: some browsers read the URL after click() returns.
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function save(conversation: ExportConversation, format: ExportFormat): void {
	const now = new Date();
	const l = labels();
	const title = conversation.title.trim() || l.untitled;
	if (format === "md") {
		download(exportFilename(title, "md", now), buildMarkdown(conversation, { exportedAt: now, labels: l, lang: currentLang() }), "text/markdown");
	} else {
		const text = buildJson(conversation, { exportedAt: now, includeTree: format === "json-tree", untitled: l.untitled });
		download(exportFilename(title, "json", now), text, "application/json");
	}
	showToast(t("exportDone"), "success", 2500);
}

export async function exportCurrent(chat: CurrentChat, format: ExportFormat): Promise<void> {
	const conversation = await currentConversation(() => chat.history(), t("historyGreeting"));
	if (!conversation) {
		showToast(t("exportNothing"));
		return;
	}
	save(conversation, format);
}

export async function exportSaved(conversationId: string, format: ExportFormat): Promise<void> {
	try {
		save(await savedConversation(conversationId), format);
	} catch {
		showToast(t("exportFailed"), "error");
	}
}

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Print the conversation on screen, with a title heading for the page. */
export async function printCurrent(chat: CurrentChat): Promise<void> {
	const conversation = await currentConversation(() => chat.history(), t("historyGreeting"));
	const container = document.querySelector(".chat-container");
	if (!container) return;
	document.querySelector(".print-header")?.remove();
	const header = document.createElement("div");
	header.className = "print-header";
	const h1 = document.createElement("h1");
	h1.dir = "auto";
	h1.textContent = conversation?.title.trim() || t("untitledChat");
	const date = document.createElement("p");
	date.textContent = t("exportedOn", {
		date: new Intl.DateTimeFormat(currentLang(), { dateStyle: "long", timeStyle: "short" }).format(new Date()),
	});
	header.append(h1, date);
	container.prepend(header);

	// The Arabic face is fetched only when Arabic text renders; make sure
	// it has arrived before the print is laid out, or it prints in a fallback.
	const text = document.getElementById("chat-messages")?.textContent ?? "";
	if (ARABIC.test(text) || ARABIC.test(h1.textContent)) {
		try {
			await document.fonts.load('400 1em "Noto Sans Arabic"', "العربية");
			await document.fonts.ready;
		} catch {
			// Printing in a fallback face is still better than not printing.
		}
	}
	const cleanup = () => header.remove();
	window.addEventListener("afterprint", cleanup, { once: true });
	window.print();
}
