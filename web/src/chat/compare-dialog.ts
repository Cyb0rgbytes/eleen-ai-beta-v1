/**
 * The compare chooser (M5.4), loaded on first use: a native <dialog> in the
 * top layer, styled with the keys form's shell (DESIGN.md section 7), with
 * one checkbox per model.
 *
 * Two or three may be chosen. Once three are, the rest are disabled until
 * one is unchecked. A locked model (sign in, or add a key) is listed with
 * its reason and cannot be chosen. Escape or Cancel changes nothing.
 */
import { MAX_COMPARE_LANES } from "../../../src/shared/stream";
import { t } from "../i18n";
import { icon } from "../ui/icons";
import type { CompareOption } from "./picker";

export interface CompareDialogOptions {
	choices: readonly CompareOption[];
	selected: readonly string[];
	/** Compare is on now, so "Turn off" is offered. */
	active: boolean;
	/** The models chosen, or [] to turn compare off. */
	onApply(values: string[]): void;
	onClose?(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

export function openCompareDialog(options: CompareDialogOptions): HTMLDialogElement {
	const dialog = el("dialog", "keys-dialog compare-dialog");
	dialog.setAttribute("aria-labelledby", "compare-title");

	const head = el("div", "keys-head");
	const title = el("h2", "keys-title");
	title.id = "compare-title";
	title.append(icon("columns"));
	const titleText = el("span");
	titleText.textContent = t("compareTitle");
	title.append(titleText);
	const closeButton = el("button", "keys-close");
	closeButton.type = "button";
	closeButton.append(icon("x"));
	const closeLabel = el("span", "sr-only");
	closeLabel.textContent = t("close");
	closeButton.append(closeLabel);
	closeButton.title = t("close");
	head.append(title, closeButton);

	const intro = el("p", "keys-intro");
	intro.id = "compare-intro";
	intro.textContent = t("compareIntro");

	const list = el("fieldset", "compare-options");
	list.setAttribute("aria-describedby", intro.id);
	const legend = el("legend", "sr-only");
	legend.textContent = t("compareTitle");
	list.append(legend);

	const boxes: HTMLInputElement[] = [];
	options.choices.forEach((choice, index) => {
		const row = el("label", "compare-option");
		const box = el("input");
		box.type = "checkbox";
		box.value = choice.value;
		box.id = `compare-option-${index}`;
		box.checked = !choice.lock && options.selected.includes(choice.value);
		box.disabled = choice.lock !== null;
		if (choice.lock) {
			row.classList.add("is-locked");
			box.dataset.locked = "";
		}
		const text = el("span", "compare-option-text");
		const name = el("span", "compare-option-name");
		name.textContent = choice.name;
		const detail = el("span", "compare-option-detail");
		detail.textContent = choice.lock
			? `${choice.detail} · ${t(choice.lock === "sign-in" ? "lockedSignIn" : "lockedAddKey")}`
			: choice.detail;
		text.append(name, detail);
		row.append(box, text);
		list.append(row);
		boxes.push(box);
	});

	const status = el("p", "compare-status");
	status.setAttribute("role", "status");

	const actions = el("div", "compare-actions");
	const off = el("button", "compare-off");
	off.type = "button";
	off.textContent = t("compareOff");
	off.hidden = !options.active;
	const cancel = el("button", "compare-cancel");
	cancel.type = "button";
	cancel.textContent = t("compareCancel");
	const apply = el("button", "compare-apply");
	apply.type = "button";
	apply.textContent = t("compareApply");
	actions.append(off, cancel, apply);

	const panel = el("div", "keys-panel");
	panel.append(head, intro, list, status, actions);
	dialog.append(panel);

	const chosen = () => boxes.filter((b) => b.checked).map((b) => b.value);

	function sync() {
		const count = chosen().length;
		status.textContent = t("compareCount", { count });
		apply.disabled = count < 2 || count > MAX_COMPARE_LANES;
		for (const box of boxes) {
			if (box.dataset.locked !== undefined) continue;
			box.disabled = !box.checked && count >= MAX_COMPARE_LANES;
		}
	}
	list.addEventListener("change", sync);
	sync();

	const close = () => dialog.close();
	closeButton.addEventListener("click", close);
	cancel.addEventListener("click", close);
	off.addEventListener("click", () => {
		options.onApply([]);
		close();
	});
	apply.addEventListener("click", () => {
		if (apply.disabled) return;
		options.onApply(chosen());
		close();
	});
	// The dialog has no padding of its own: a click on it is a click on the backdrop.
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) close();
	});
	dialog.addEventListener("close", () => {
		dialog.remove();
		options.onClose?.();
	});

	document.body.append(dialog);
	dialog.showModal();
	(boxes.find((b) => !b.disabled) ?? cancel).focus();
	return dialog;
}
