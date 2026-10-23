/**
 * The Export button (M5.3): a ghost button at the inline-start of the auth
 * plate, beside the theme and language toggles, shown once the chat on
 * screen has something to export. Guests can export too; it is all client
 * side.
 *
 * Only the button is in the initial bundle. Its menu (the sidebar's menu
 * button pattern, sidebar/menu.ts) and the builders load on first click.
 *
 *   Markdown (.md)
 *   JSON (.json)
 *   JSON, every branch (.json)   saved chats only: edits and regenerations
 *   Print / Save as PDF
 */
import { CONVERSATION_CHANGED_EVENT, getHistoryState } from "../history/state";
import { t } from "../i18n";
import { icon } from "../ui/icons";
import type { CurrentChat } from "./actions";

export function initExportControl(chat: CurrentChat): void {
	const host = document.querySelector(".auth-container");
	if (!host) return;

	const wrap = document.createElement("div");
	wrap.className = "export-control";
	const button = document.createElement("button");
	button.type = "button";
	button.id = "export-button";
	button.className = "pref-button";
	button.title = t("exportChat");
	button.setAttribute("aria-haspopup", "menu");
	button.setAttribute("aria-expanded", "false");
	const label = document.createElement("span");
	label.className = "sr-only";
	label.textContent = t("exportChat");
	button.append(icon("export"), label);
	wrap.append(button);
	host.prepend(wrap);

	const hasContent = () => Boolean(getHistoryState().conversationId) || chat.history().some((m, i) => i > 0 && m.role === "user");
	const update = () => {
		const show = hasContent();
		if (!show && button.getAttribute("aria-expanded") === "true") button.click();
		wrap.hidden = !show;
	};
	update();
	const messages = document.getElementById("chat-messages");
	if (messages) new MutationObserver(update).observe(messages, { childList: true });
	window.addEventListener(CONVERSATION_CHANGED_EVENT, update);
	document.addEventListener("eleen:turn-complete", update);

	button.addEventListener("click", () => {
		void Promise.all([import("../sidebar/menu"), import("./actions")]).then(([menu, actions]) => {
			const saved = Boolean(getHistoryState().conversationId);
			menu.toggleMenu(button, button, () => [
				{ label: t("exportMarkdown"), onSelect: () => void actions.exportCurrent(chat, "md") },
				{ label: t("exportJson"), onSelect: () => void actions.exportCurrent(chat, "json") },
				...(saved ? [{ label: t("exportJsonTree"), onSelect: () => void actions.exportCurrent(chat, "json-tree") }] : []),
				{ label: t("exportPrint"), onSelect: () => void actions.printCurrent(chat) },
			]);
		});
	});
}
