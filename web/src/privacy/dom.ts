/**
 * Small DOM pieces the consent dialog and the privacy panel share. Every
 * string arrives as textContent; nothing here parses HTML.
 */
import { t } from "../i18n";
import { icon, type IconName } from "../ui/icons";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

export function button(className: string, text: string): HTMLButtonElement {
	const b = el("button", className);
	b.type = "button";
	b.textContent = text;
	return b;
}

/** The dialog heading: an icon and a title the dialog is labelled by. */
export function dialogHead(id: string, glyph: IconName, text: string, onClose: () => void): { head: HTMLElement; close: HTMLButtonElement } {
	const head = el("div", "privacy-head");
	const title = el("h2", "privacy-title");
	title.id = id;
	title.append(icon(glyph));
	const titleText = el("span");
	titleText.textContent = text;
	title.append(titleText);
	const close = el("button", "privacy-close");
	close.type = "button";
	close.title = t("close");
	close.append(icon("x"));
	const label = el("span", "sr-only");
	label.textContent = t("close");
	close.append(label);
	close.addEventListener("click", onClose);
	head.append(title, close);
	return { head, close };
}

export interface Switch {
	readonly root: HTMLElement;
	readonly input: HTMLInputElement;
}

/**
 * A labelled on/off control: a native checkbox with role="switch", so the
 * keyboard (Space) and screen readers get it for free. The hint under the
 * label is its description.
 */
export function switchField(id: string, label: string, hint: string): Switch {
	const root = el("div", "privacy-switch");
	const input = el("input", "privacy-switch-input");
	input.type = "checkbox";
	input.id = id;
	input.setAttribute("role", "switch");
	const hintId = `${id}-hint`;
	input.setAttribute("aria-describedby", hintId);
	const text = el("label", "privacy-switch-text");
	text.htmlFor = id;
	const name = el("span", "privacy-switch-label");
	name.textContent = label;
	const description = el("span", "privacy-switch-hint");
	description.id = hintId;
	description.textContent = hint;
	text.append(name, description);
	root.append(text, input);
	return { root, input };
}

/** A same-origin link to the policy page; it opens in a new tab so the dialog keeps its state. */
export function policyLink(className: string): HTMLAnchorElement {
	const a = el("a", className);
	a.href = "/privacy";
	a.target = "_blank";
	a.rel = "noopener";
	a.textContent = t("consentPolicyLink");
	return a;
}

export function showModal(dialog: HTMLDialogElement): void {
	if (!dialog.isConnected) document.body.append(dialog);
	if (dialog.open) return;
	if (typeof dialog.showModal === "function") dialog.showModal();
	else dialog.setAttribute("open", "");
}

export function closeModal(dialog: HTMLDialogElement): void {
	if (typeof dialog.close === "function" && dialog.open) dialog.close();
	else if (dialog.hasAttribute("open")) {
		dialog.removeAttribute("open");
		dialog.dispatchEvent(new Event("close"));
	}
}
