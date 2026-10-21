/**
 * Consent and the memory-and-privacy panel, wired to the auth state (M4.6).
 *
 * This is the only part in the initial bundle, and it is small on purpose:
 * the consent dialog and the panel are dynamic imports, fetched the first
 * time one is needed. A guest never downloads either one.
 *
 * - On every sign-in, GET /api/v1/consent. If it was never answered, or was
 *   answered for an older policy, the consent dialog opens. If the check
 *   fails (offline, or the route is not deployed yet), nothing is shown and
 *   nothing is saved: the server's defaults hold and the next visit asks.
 * - The panel opens from "Memory and privacy" in the model picker's popover,
 *   beside "Manage API keys", shown only while signed in.
 * - On sign-out both dialogs close and drop what they showed.
 */
import type { ConsentResponse } from "../../../src/shared/history";
import { subscribeAuth, type AuthState } from "../auth/clerk";
import { t } from "../i18n";
import { icon } from "../ui/icons";
import { getConsent, needsConsent } from "./api";
import type { ConsentDialog } from "./consent";
import type { PrivacyPanel } from "./panel";

export interface PrivacyOptions {
	/** Close the model picker's popover before the panel opens. */
	closePicker?(): void;
	/** Where focus goes when the panel closes. */
	focusPicker?(): void;
	/** Injected for tests; defaults to the real auth state. */
	subscribe?(listener: (state: AuthState) => void): () => void;
	/** Injected for tests; defaults to GET /api/v1/consent. */
	loadConsent?(): Promise<ConsentResponse>;
}

export interface Privacy {
	openPanel(): Promise<void>;
	/** Resolves once the current consent check, if any, has finished. */
	settled(): Promise<void>;
}

export function initPrivacy(options: PrivacyOptions = {}): Privacy {
	const link = document.querySelector<HTMLButtonElement>(".model-privacy-link");
	if (link) {
		const label = document.createElement("span");
		label.textContent = t("privacyOpen");
		link.replaceChildren(icon("shield-check"), label);
		link.hidden = true;
	}

	let signedIn = false;
	/** Bumped on every auth change, so a late answer for an old session is dropped. */
	let session = 0;
	let consentDialog: ConsentDialog | null = null;
	let panel: PrivacyPanel | null = null;
	let pending: Promise<void> = Promise.resolve();
	/** What had focus when the consent dialog opened by itself. */
	let returnTo: Element | null = null;

	async function checkConsent(mine: number): Promise<void> {
		let response: ConsentResponse;
		try {
			response = await (options.loadConsent ?? (() => getConsent()))();
		} catch {
			return;
		}
		if (mine !== session || !needsConsent(response)) return;
		const { createConsentDialog } = await import("./consent");
		if (mine !== session) return;
		consentDialog ??= createConsentDialog({
			onClose: () => {
				// Back where they were, or to the composer: never lost to <body>.
				const target = returnTo instanceof HTMLElement && returnTo.isConnected && returnTo !== document.body ? returnTo : document.getElementById("user-input");
				target?.focus();
			},
		});
		returnTo = document.activeElement;
		consentDialog.open(response);
	}

	function apply(state: AuthState) {
		if (state.status === "loading") return;
		const next = state.status === "signed-in";
		if (next === signedIn) return;
		signedIn = next;
		session++;
		if (link) link.hidden = !next;
		if (next) {
			pending = checkConsent(session);
		} else {
			consentDialog?.close();
			panel?.reset();
		}
	}

	async function openPanel(): Promise<void> {
		if (!signedIn) return;
		options.closePicker?.();
		const mine = session;
		const { createPrivacyPanel } = await import("./panel");
		if (mine !== session) return;
		panel ??= createPrivacyPanel({ onClose: () => options.focusPicker?.() });
		panel.open();
	}

	link?.addEventListener("click", () => void openPanel());

	(options.subscribe ?? subscribeAuth)(apply);

	return { openPanel, settled: () => pending };
}
