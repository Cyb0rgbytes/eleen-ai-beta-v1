/**
 * The consent dialog (M4.6): asked once of a signed-in user, before their
 * conversations or anything about them is kept on their say-so.
 *
 * Two switches, at the contract's defaults (src/shared/history.ts): saving
 * conversations on, remembering facts off. Only "Save my choices" sends
 * anything. Escape, the close button and "Ask me later" all leave without a
 * request, so nothing is ever saved by walking away; the question comes
 * back on the next visit.
 *
 * A native <dialog> opened with showModal(), like the keys form: the top
 * layer (no z-index), a native focus trap, Escape to close. A click on the
 * backdrop does not close it: this is a choice to make, not a popover to
 * brush aside by accident.
 */
import type { ConsentResponse } from "../../../src/shared/history";
import { t } from "../i18n";
import { showToast } from "../ui/toast";
import { choicesOf, putConsent } from "./api";
import { button, closeModal, dialogHead, el, policyLink, showModal, switchField } from "./dom";

export interface ConsentDialogOptions {
	/** After a successful save, with the server's answer. */
	onSaved?(response: ConsentResponse): void;
	/** After the dialog closes, saved or not. */
	onClose?(saved: boolean): void;
}

export interface ConsentDialog {
	readonly element: HTMLDialogElement;
	open(current: ConsentResponse): void;
	close(): void;
}

export function createConsentDialog(options: ConsentDialogOptions = {}): ConsentDialog {
	const dialog = el("dialog", "privacy-dialog consent-dialog");
	dialog.setAttribute("aria-labelledby", "consent-title");
	dialog.setAttribute("aria-describedby", "consent-intro");

	const { head } = dialogHead("consent-title", "shield-check", t("consentTitle"), () => close());

	const intro = el("p", "privacy-intro");
	intro.id = "consent-intro";
	intro.textContent = t("consentIntro");
	// Shown only when an earlier answer was for an older policy.
	const changed = el("p", "privacy-note");
	changed.textContent = t("consentPolicyChanged");
	changed.hidden = true;

	const history = switchField("consent-history", t("consentHistoryLabel"), t("consentHistoryHint"));
	const memory = switchField("consent-memory", t("consentMemoryLabel"), t("consentMemoryHint"));
	const switches = el("div", "privacy-switches");
	switches.append(history.root, memory.root);

	const link = policyLink("privacy-link");

	const error = el("p", "privacy-error");
	error.setAttribute("role", "alert");
	error.hidden = true;

	const actions = el("div", "privacy-actions");
	const later = button("privacy-button", t("consentLater"));
	const save = button("privacy-button is-primary", t("consentSave"));
	actions.append(later, save);

	const panel = el("div", "privacy-panel");
	panel.append(head, intro, changed, switches, link, error, actions);
	dialog.append(panel);

	let saved = false;
	let busy = false;

	function setBusy(next: boolean) {
		busy = next;
		save.disabled = next;
		later.disabled = next;
		history.input.disabled = next;
		memory.input.disabled = next;
		save.textContent = next ? t("consentSaving") : t("consentSave");
		dialog.setAttribute("aria-busy", String(next));
	}

	function showError(message: string | null) {
		error.hidden = message === null;
		error.textContent = message ?? "";
	}

	function open(current: ConsentResponse) {
		const choices = choicesOf(current);
		history.input.checked = choices.history;
		memory.input.checked = choices.memory;
		changed.hidden = current.consent === null;
		saved = false;
		showError(null);
		setBusy(false);
		showModal(dialog);
		// The first decision, not the close button: a keyboard user can act at once.
		history.input.focus();
	}

	function close() {
		if (busy) return;
		closeModal(dialog);
	}

	save.addEventListener("click", async () => {
		if (busy) return;
		showError(null);
		setBusy(true);
		try {
			const response = await putConsent({ history: history.input.checked, memory: memory.input.checked });
			saved = true;
			setBusy(false);
			options.onSaved?.(response);
			close();
			showToast(t("consentSaved"), "success");
		} catch {
			setBusy(false);
			showError(t("consentSaveFailed"));
			save.focus();
		}
	});

	later.addEventListener("click", () => close());

	// Escape while a save is in flight would leave it unclear what was kept.
	dialog.addEventListener("cancel", (event) => {
		if (busy) event.preventDefault();
	});

	dialog.addEventListener("close", () => options.onClose?.(saved));

	return { element: dialog, open, close };
}
