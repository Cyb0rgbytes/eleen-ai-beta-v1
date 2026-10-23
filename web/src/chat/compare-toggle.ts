/**
 * The Compare toggle in the composer's controls row (M5.4).
 *
 * Off, it reads "Compare"; on, "Compare 3", pressed, in the accent. A
 * guest pressing it gets the sign-in modal, since compare is for signed-in
 * users. Otherwise it opens the chooser, which is loaded on first use
 * (compare-dialog.ts) so the page's initial script stays within budget.
 */
import { t } from "../i18n";
import { setIcon } from "../ui/icons";
import { showToast } from "../ui/toast";
import type { ChatApi } from "./controller";
import type { CompareOption } from "./picker";

export interface CompareToggleOptions {
	chat: Pick<ChatApi, "setCompare" | "compareModels">;
	/** The models to choose from, with their locks (the picker's rows). */
	choices(): CompareOption[];
	openSignIn(): void;
}

export interface CompareToggle {
	setSignedIn(signedIn: boolean): void;
}

export function initCompareToggle(button: HTMLButtonElement, options: CompareToggleOptions): CompareToggle {
	let signedIn = false;
	const label = document.createElement("span");
	label.className = "compare-btn-label";
	button.replaceChildren(label);
	setIcon(button, "columns");

	function render() {
		const count = options.chat.compareModels()?.length ?? 0;
		label.textContent = count ? t("compareOn", { count }) : t("compare");
		button.setAttribute("aria-pressed", String(count > 0));
		button.title = count ? t("compareButtonOnLabel", { count }) : t("compareButtonLabel");
		button.setAttribute("aria-label", button.title);
	}

	button.addEventListener("click", async () => {
		if (!signedIn) {
			options.openSignIn();
			return;
		}
		const { openCompareDialog } = await import("./compare-dialog");
		const current = options.chat.compareModels() ?? [];
		openCompareDialog({
			choices: options.choices(),
			selected: current.map((c) => c.value),
			active: current.length > 0,
			onApply(values) {
				const byValue = new Map(options.choices().map((c) => [c.value, c]));
				const picked = values
					.map((value) => byValue.get(value))
					.filter((c): c is CompareOption => c !== undefined)
					.map((c) => ({ value: c.value, label: c.name }));
				options.chat.setCompare(picked.length >= 2 ? picked : null);
				render();
				const count = options.chat.compareModels()?.length ?? 0;
				showToast(count ? t("compareStarted", { count }) : t("compareEnded"), "success", 2500);
			},
			onClose: () => button.focus(),
		});
	});

	render();

	return {
		setSignedIn(next) {
			if (next === signedIn) return;
			signedIn = next;
			// Compare does not outlive the session it was chosen in.
			if (!next) options.chat.setCompare(null);
			render();
		},
	};
}
