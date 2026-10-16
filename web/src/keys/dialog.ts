/**
 * The keys form (DESIGN.md section 7): a --surface-solid dialog listing the
 * four providers, each with the stored key's last four, Replace and Remove.
 *
 * Built on a native <dialog> opened with showModal(), so it sits in the
 * browser's top layer like Clerk's modals: no z-index, a native focus trap,
 * and Escape closes it.
 *
 * The key a person pastes lives in the DOM only until they press Save. The
 * field is cleared before the request leaves, whatever the outcome, so a
 * key is never left sitting in the page; after a 422 they paste it again.
 */
import { t } from "../i18n";
import { icon } from "../ui/icons";
import { showToast } from "../ui/toast";
import { KEY_PROVIDERS, PROVIDER_NAMES, listKeys, removeKey, saveKey, type KeyProvider, type StoredKey } from "./api";

export interface KeysDialogOptions {
	/** Called whenever the set of providers with a stored key changes. */
	onChange(providers: ReadonlySet<KeyProvider>): void;
	/** Called after the dialog closes, to return focus where it came from. */
	onClose?(): void;
}

export interface KeysDialog {
	readonly element: HTMLDialogElement;
	open(focus?: KeyProvider): void;
	close(): void;
	/** Reload the stored keys from the server (on sign-in). */
	refresh(): Promise<void>;
	/** Forget everything (on sign-out). */
	reset(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

function button(className: string, text: string): HTMLButtonElement {
	const b = el("button", className);
	b.type = "button";
	b.textContent = text;
	return b;
}

interface Row {
	readonly root: HTMLLIElement;
	render(stored: StoredKey | undefined, loading: boolean): void;
	openForm(): void;
	closeForm(): void;
	status(message: string, tone?: "ok" | "error"): void;
}

export function createKeysDialog(options: KeysDialogOptions): KeysDialog {
	const dialog = el("dialog", "keys-dialog");
	dialog.setAttribute("aria-labelledby", "keys-title");

	const head = el("div", "keys-head");
	const title = el("h2", "keys-title");
	title.id = "keys-title";
	title.append(icon("key"));
	const titleText = el("span");
	titleText.textContent = t("keysTitle");
	title.append(titleText);
	const closeButton = el("button", "keys-close");
	closeButton.type = "button";
	closeButton.append(icon("x"));
	const closeLabel = el("span", "sr-only");
	closeLabel.textContent = t("close");
	closeButton.append(closeLabel);
	closeButton.title = t("close");
	closeButton.addEventListener("click", () => close());
	head.append(title, closeButton);

	const intro = el("p", "keys-intro");
	intro.textContent = t("keysIntro");
	const listStatus = el("p", "keys-list-status");
	listStatus.setAttribute("role", "status");
	const list = el("ul", "keys-list");
	// The dialog has no padding of its own, so a click whose target is the
	// dialog element can only be on the backdrop.
	const panel = el("div", "keys-panel");
	panel.append(head, intro, listStatus, list);
	dialog.append(panel);

	let stored = new Map<KeyProvider, StoredKey>();
	let loading = false;
	let loaded = false;

	function notify() {
		options.onChange(new Set(stored.keys()));
	}

	function createRow(provider: KeyProvider): Row {
		const name = PROVIDER_NAMES[provider];
		const root = el("li", "key-row");
		root.dataset.provider = provider;

		const main = el("div", "key-row-main");
		const label = el("span", "key-provider");
		label.textContent = name;
		const masked = el("span", "key-masked");
		const actions = el("div", "key-actions");
		const replace = button("key-action", t("keyAdd"));
		const remove = button("key-action is-danger", t("keyRemove"));
		actions.append(replace, remove);
		main.append(label, masked, actions);

		const form = el("form", "key-form");
		form.hidden = true;
		form.noValidate = true;
		const inputId = `key-input-${provider}`;
		const errorId = `key-error-${provider}`;
		const fieldLabel = el("label", "key-label");
		fieldLabel.htmlFor = inputId;
		fieldLabel.textContent = t("keyLabel", { provider: name });
		const input = el("input", "key-input");
		input.id = inputId;
		input.name = "key";
		input.type = "password";
		input.autocomplete = "off";
		input.spellcheck = false;
		input.maxLength = 512;
		input.setAttribute("autocapitalize", "off");
		input.setAttribute("aria-describedby", errorId);
		const error = el("p", "key-error");
		error.id = errorId;
		error.hidden = true;
		const formActions = el("div", "key-form-actions");
		const save = el("button", "key-save");
		save.type = "submit";
		save.textContent = t("keySave");
		const cancel = button("key-action", t("keyCancel"));
		formActions.append(save, cancel);
		form.append(fieldLabel, input, error, formActions);

		const status = el("p", "key-status");
		status.setAttribute("role", "status");

		root.append(main, form, status);

		let confirming: ReturnType<typeof setTimeout> | undefined;

		function showError(message: string | null) {
			error.hidden = message === null;
			error.textContent = message ?? "";
			if (message === null) input.removeAttribute("aria-invalid");
			else input.setAttribute("aria-invalid", "true");
		}

		function resetRemove() {
			clearTimeout(confirming);
			confirming = undefined;
			remove.textContent = t("keyRemove");
			remove.classList.remove("is-confirming");
		}

		const row: Row = {
			root,
			render(key, busy) {
				if (key && !busy) {
					// "Ends in {last4}", with the four characters set in mono.
					const [before = "", after = ""] = t("keyMasked", { last4: "\u0000" }).split("\u0000");
					const last4 = el("span", "key-last4");
					last4.textContent = key.last4;
					masked.replaceChildren(before, last4, after);
				} else {
					masked.textContent = busy ? t("keysLoading") : t("keyNone");
				}
				masked.classList.toggle("is-empty", !key);
				replace.textContent = key ? t("keyReplace") : t("keyAdd");
				replace.disabled = busy;
				remove.hidden = !key;
				resetRemove();
			},
			openForm() {
				form.hidden = false;
				replace.hidden = true;
				showError(null);
				status.textContent = "";
				input.focus();
			},
			closeForm() {
				form.hidden = true;
				replace.hidden = false;
				input.value = "";
				showError(null);
			},
			status(message, tone) {
				status.textContent = message;
				status.dataset.tone = tone ?? "";
			},
		};

		replace.addEventListener("click", () => row.openForm());
		cancel.addEventListener("click", () => {
			row.closeForm();
			replace.focus();
		});

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const key = input.value.trim();
			// Out of the DOM before anything leaves the page.
			input.value = "";
			if (!key) {
				showError(t("keyRequired"));
				input.focus();
				return;
			}
			showError(null);
			save.disabled = true;
			cancel.disabled = true;
			input.disabled = true;
			row.status(t("keyChecking", { provider: name }));
			const result = await saveKey(provider, key);
			save.disabled = false;
			cancel.disabled = false;
			input.disabled = false;
			if (result.ok) {
				stored.set(provider, result.stored);
				row.closeForm();
				row.render(result.stored, false);
				row.status(
					result.verified
						? t("keySaved", { last4: result.stored.last4 })
						: t("keySavedUnverified", { provider: name }),
					"ok",
				);
				replace.focus();
				notify();
				return;
			}
			row.status("");
			const messages = {
				invalid: t("keyInvalid", { provider: name }),
				rejected: t("keyRejected", { provider: name }),
				unavailable: t("keyStoreUnavailable"),
				failed: t("keySaveFailed"),
			} as const;
			showError(messages[result.reason]);
			input.focus();
		});

		// Remove asks once more, in place, before it acts.
		remove.addEventListener("click", async () => {
			if (!confirming) {
				remove.textContent = t("keyConfirmRemove");
				remove.classList.add("is-confirming");
				confirming = setTimeout(resetRemove, 4000);
				return;
			}
			resetRemove();
			remove.disabled = true;
			const removed = await removeKey(provider);
			remove.disabled = false;
			if (!removed) {
				row.status(t("keyRemoveFailed"), "error");
				return;
			}
			stored.delete(provider);
			row.render(undefined, false);
			row.status("");
			showToast(t("keyRemoved", { provider: name }), "success");
			replace.focus();
			notify();
		});

		return row;
	}

	const rows = new Map<KeyProvider, Row>(KEY_PROVIDERS.map((p) => [p, createRow(p)]));
	for (const row of rows.values()) list.append(row.root);

	function renderAll() {
		for (const [provider, row] of rows) row.render(stored.get(provider), loading && !loaded);
	}
	renderAll();

	async function refresh(): Promise<void> {
		loading = true;
		listStatus.textContent = "";
		renderAll();
		try {
			const keys = await listKeys();
			stored = new Map(keys.map((k) => [k.provider, k]));
			loaded = true;
			notify();
		} catch {
			listStatus.textContent = t("keysFailed");
		} finally {
			loading = false;
			renderAll();
		}
	}

	function open(focus?: KeyProvider) {
		if (!dialog.isConnected) document.body.append(dialog);
		for (const row of rows.values()) {
			row.closeForm();
			row.status("");
		}
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		if (!loaded && !loading) void refresh();
		const row = focus ? rows.get(focus) : undefined;
		if (row) {
			row.root.scrollIntoView?.({ block: "nearest" });
			// A locked model sent them here: go straight to that key's field.
			if (!stored.has(focus as KeyProvider)) row.openForm();
		} else {
			closeButton.focus();
		}
	}

	function close() {
		if (typeof dialog.close === "function" && dialog.open) dialog.close();
		else {
			dialog.removeAttribute("open");
			dialog.dispatchEvent(new Event("close"));
		}
	}

	// Native close (Escape, close()) clears any half-typed key.
	dialog.addEventListener("close", () => {
		for (const row of rows.values()) row.closeForm();
		options.onClose?.();
	});

	// A click on the backdrop lands on the dialog itself.
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) close();
	});

	return {
		element: dialog,
		open,
		close,
		refresh,
		reset() {
			stored = new Map();
			loaded = false;
			renderAll();
			if (dialog.open) close();
			notify();
		},
	};
}
