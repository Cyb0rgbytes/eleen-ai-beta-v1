/**
 * Inline editing of a sent message in a saved chat (M4.3).
 *
 * The bubble and its action row are hidden and a textarea takes their
 * place, with Save and send and Cancel under it. Escape cancels and
 * Ctrl/Cmd+Enter saves. Saving hands the new text to the caller, which
 * sends it as a sibling of the edited turn; the editor itself never talks
 * to the network.
 *
 *   .user-turn.is-editing
 *     .message.user-message   [hidden]
 *     .turn-actions           [hidden]
 *     .turn-editor
 *       textarea.turn-editor-input[dir=auto]
 *       .turn-editor-actions > button.edit-cancel, button.edit-save
 */
import { t } from "../i18n";

export interface EditorHandlers {
	onSave(text: string): void;
	onCancel?(): void;
}

const MAX_ROWS = 10;

function fit(textarea: HTMLTextAreaElement) {
	textarea.rows = Math.min(MAX_ROWS, Math.max(2, textarea.value.split("\n").length));
}

/** Open the editor on a user turn. Returns the textarea, or the open one if it already is. */
export function openEditor(turn: HTMLElement, original: string, handlers: EditorHandlers): HTMLTextAreaElement {
	const open = turn.querySelector<HTMLTextAreaElement>(":scope > .turn-editor textarea");
	if (open) {
		open.focus();
		return open;
	}

	const hidden = [...turn.querySelectorAll<HTMLElement>(":scope > .user-message, :scope > .turn-actions")];
	for (const node of hidden) node.hidden = true;
	turn.classList.add("is-editing");

	const editor = document.createElement("div");
	editor.className = "turn-editor";
	const textarea = document.createElement("textarea");
	textarea.className = "turn-editor-input";
	textarea.dir = "auto";
	textarea.value = original;
	textarea.setAttribute("aria-label", t("editMessage"));
	fit(textarea);

	const row = document.createElement("div");
	row.className = "turn-editor-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "edit-cancel";
	cancel.textContent = t("editCancel");
	const save = document.createElement("button");
	save.type = "button";
	save.className = "edit-save";
	save.textContent = t("editSave");
	row.append(cancel, save);
	editor.append(textarea, row);
	turn.append(editor);

	const close = () => {
		editor.remove();
		for (const node of hidden) node.hidden = false;
		turn.classList.remove("is-editing");
	};
	const doCancel = () => {
		close();
		handlers.onCancel?.();
		turn.querySelector<HTMLButtonElement>(".edit-button")?.focus();
	};
	const doSave = () => {
		const text = textarea.value.trim();
		if (!text || save.disabled) return;
		close();
		handlers.onSave(text);
	};

	textarea.addEventListener("input", () => {
		fit(textarea);
		save.disabled = !textarea.value.trim();
	});
	textarea.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			doCancel();
		} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			doSave();
		}
	});
	cancel.addEventListener("click", doCancel);
	save.addEventListener("click", doSave);

	textarea.focus();
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	return textarea;
}
