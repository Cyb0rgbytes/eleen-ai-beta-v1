/**
 * Memory and privacy (M4.6): the signed-in user's own view of what EleenAI
 * keeps about them, and the controls to stop it or delete it.
 *
 * Three sections in one native <dialog> (top layer, focus trap, Escape):
 *
 * - The two consent switches. Each change is saved as it is made. Turning
 *   memory off forgets every stored fact (src/shared/history.ts), so that
 *   one switch asks first, inline, and saves only on a second press.
 * - The remembered facts, each with Forget, and Forget everything behind an
 *   inline confirm.
 * - Delete all my conversations, behind an inline confirm.
 *
 * No window.confirm anywhere: the confirms live inside the dialog, so they
 * are styled, translated, and inside the focus trap. Every list and load has
 * a designed loading, empty and error state (DESIGN.md principle 7).
 *
 * Facts are model-derived text. They reach the page as textContent with
 * dir="auto", never as markup.
 */
import type { ConsentUpdate, MemoryEntry } from "../../../src/shared/history";
import { t } from "../i18n";
import { icon } from "../ui/icons";
import { choicesOf, deleteAllConversations, forgetAllMemory, forgetFact, getConsent, listMemory, putConsent } from "./api";
import { button, closeModal, dialogHead, el, policyLink, showModal, switchField } from "./dom";

/** Fired on window after every saved conversation is deleted, for the sidebar. */
export const HISTORY_DELETED_EVENT = "eleen:history-deleted";

export interface PrivacyPanelOptions {
	/** After the panel closes, to return focus where it came from. */
	onClose?(): void;
}

export interface PrivacyPanel {
	readonly element: HTMLDialogElement;
	open(): void;
	close(): void;
	/** Forget everything shown (on sign-out). */
	reset(): void;
}

type Tone = "ok" | "error" | "";

function status(): HTMLParagraphElement {
	const p = el("p", "privacy-status");
	p.setAttribute("role", "status");
	return p;
}

function say(target: HTMLElement, message: string, tone: Tone = "") {
	target.textContent = message;
	target.dataset.tone = tone;
}

function section(id: string, heading: string): HTMLElement {
	const root = el("section", "privacy-section");
	root.setAttribute("aria-labelledby", id);
	const h = el("h3", "privacy-section-title");
	h.id = id;
	h.textContent = heading;
	root.append(h);
	return root;
}

interface Confirm {
	readonly root: HTMLElement;
	readonly yes: HTMLButtonElement;
	show(): void;
	hide(): void;
	readonly shown: boolean;
}

/**
 * An inline "are you sure": a sentence and two buttons, in place of the
 * action. Focus lands on the safe choice, so a stray Enter does nothing
 * destructive.
 */
function inlineConfirm(message: string, yesLabel: string, noLabel: string, onYes: () => void, onNo: () => void): Confirm {
	const root = el("div", "privacy-confirm");
	root.setAttribute("role", "group");
	const text = el("p", "privacy-confirm-text");
	text.textContent = message;
	const row = el("div", "privacy-actions");
	const no = button("privacy-button", noLabel);
	const yes = button("privacy-button is-danger", yesLabel);
	row.append(no, yes);
	root.append(text, row);
	root.hidden = true;
	const id = `confirm-${Math.random().toString(36).slice(2, 8)}`;
	text.id = id;
	root.setAttribute("aria-labelledby", id);
	yes.addEventListener("click", onYes);
	no.addEventListener("click", onNo);
	return {
		root,
		yes,
		show() {
			root.hidden = false;
			no.focus();
		},
		hide() {
			root.hidden = true;
		},
		get shown() {
			return !root.hidden;
		},
	};
}

export function createPrivacyPanel(options: PrivacyPanelOptions = {}): PrivacyPanel {
	const dialog = el("dialog", "privacy-dialog memory-dialog");
	dialog.setAttribute("aria-labelledby", "privacy-panel-title");

	const { head, close: closeButton } = dialogHead("privacy-panel-title", "shield-check", t("privacyTitle"), () => close());
	const intro = el("p", "privacy-intro");
	intro.textContent = t("privacyIntro");

	// ── Choices ──────────────────────────────────────────────────────────
	const choicesSection = section("privacy-choices-title", t("privacyChoicesHeading"));
	const history = switchField("privacy-history", t("consentHistoryLabel"), t("consentHistoryHint"));
	const memory = switchField("privacy-memory", t("consentMemoryLabel"), t("consentMemoryHint"));
	const switches = el("div", "privacy-switches");
	switches.append(history.root, memory.root);
	const memoryOff = inlineConfirm(
		t("privacyMemoryOffWarn"),
		t("privacyMemoryOffConfirm"),
		t("privacyMemoryOffCancel"),
		() => void turnMemoryOff(),
		() => {
			memoryOff.hide();
			renderSwitches();
			memory.input.focus();
		},
	);
	memoryOff.root.classList.add("is-warning");
	const choicesStatus = status();
	const choicesRetry = button("privacy-button", t("memoryRetry"));
	choicesRetry.hidden = true;
	choicesRetry.addEventListener("click", () => void loadChoices());
	choicesSection.append(switches, memoryOff.root, choicesStatus, choicesRetry);

	// ── Memory ───────────────────────────────────────────────────────────
	const memorySection = section("privacy-memory-title", t("memoryHeading"));
	const memoryBody = el("div", "memory-body");
	const forgetAll = button("privacy-button is-danger", t("memoryForgetAll"));
	const forgetAllConfirm = inlineConfirm(
		t("memoryForgetAllConfirm"),
		t("memoryForgetAllYes"),
		t("privacyCancel"),
		() => void doForgetAll(),
		() => {
			forgetAllConfirm.hide();
			forgetAll.hidden = false;
			forgetAll.focus();
		},
	);
	forgetAll.addEventListener("click", () => {
		forgetAll.hidden = true;
		forgetAllConfirm.show();
	});
	const memoryStatus = status();
	memorySection.append(memoryBody, forgetAll, forgetAllConfirm.root, memoryStatus);

	// ── Conversations ────────────────────────────────────────────────────
	const historySection = section("privacy-history-title", t("historyHeading"));
	const historyNote = el("p", "privacy-section-note");
	historyNote.textContent = t("historyNote");
	const deleteAll = button("privacy-button is-danger", t("historyDeleteAll"));
	const deleteConfirm = inlineConfirm(
		t("historyDeleteConfirm"),
		t("historyDeleteYes"),
		t("privacyCancel"),
		() => void doDeleteAll(),
		() => {
			deleteConfirm.hide();
			deleteAll.hidden = false;
			deleteAll.focus();
		},
	);
	deleteAll.addEventListener("click", () => {
		deleteAll.hidden = true;
		say(historyStatus, "");
		deleteConfirm.show();
	});
	const historyStatus = status();
	historySection.append(historyNote, deleteAll, deleteConfirm.root, historyStatus);

	const foot = el("p", "privacy-foot");
	foot.append(policyLink("privacy-link"));

	const panel = el("div", "privacy-panel");
	panel.append(head, intro, choicesSection, memorySection, historySection, foot);
	dialog.append(panel);

	// ── State ────────────────────────────────────────────────────────────
	let choices: ConsentUpdate | null = null;
	let entries: MemoryEntry[] = [];
	let memoryState: "loading" | "ready" | "error" = "loading";
	let saving = false;
	/** Bumped on every open and reset, so a late answer for an old view is dropped. */
	let generation = 0;

	function renderSwitches() {
		const ready = choices !== null;
		history.input.checked = choices?.history ?? false;
		memory.input.checked = choices?.memory ?? false;
		history.input.disabled = !ready || saving;
		memory.input.disabled = !ready || saving || memoryOff.shown;
		switches.setAttribute("aria-busy", String(!ready || saving));
	}

	function skeleton(): HTMLElement {
		const wrap = el("div", "memory-skeleton");
		for (let i = 0; i < 3; i++) wrap.append(el("div", "skeleton-line"));
		wrap.setAttribute("aria-hidden", "true");
		const label = el("p", "sr-only");
		label.setAttribute("role", "status");
		label.textContent = t("memoryLoading");
		const box = el("div");
		box.append(wrap, label);
		return box;
	}

	function emptyState(message: string): HTMLElement {
		const p = el("p", "privacy-state");
		p.textContent = message;
		return p;
	}

	function errorState(): HTMLElement {
		const box = el("div", "privacy-state is-error");
		box.setAttribute("role", "alert");
		const text = el("p");
		text.append(icon("warning-circle"));
		const span = el("span");
		span.textContent = t("memoryFailed");
		text.append(span);
		const retry = button("privacy-button", t("memoryRetry"));
		retry.addEventListener("click", () => void loadMemory(true));
		box.append(text, retry);
		return box;
	}

	function factRow(entry: MemoryEntry): HTMLLIElement {
		const li = el("li", "memory-row");
		li.dataset.id = entry.id;
		const fact = el("span", "memory-fact");
		fact.dir = "auto";
		fact.textContent = entry.fact;
		const forget = el("button", "memory-forget");
		forget.type = "button";
		forget.title = t("memoryForget");
		forget.append(icon("x"));
		const label = el("span", "sr-only");
		label.textContent = t("memoryForgetLabel", { fact: entry.fact });
		forget.append(label);
		forget.addEventListener("click", () => void doForget(entry.id, forget));
		li.append(fact, forget);
		return li;
	}

	function renderMemory() {
		forgetAll.hidden = true;
		forgetAllConfirm.hide();
		if (memoryState === "loading") {
			memoryBody.replaceChildren(skeleton());
			return;
		}
		if (memoryState === "error") {
			memoryBody.replaceChildren(errorState());
			return;
		}
		if (entries.length === 0) {
			memoryBody.replaceChildren(emptyState(choices && !choices.memory ? t("memoryOff") : t("memoryEmpty")));
			return;
		}
		const list = el("ul", "memory-list");
		for (const entry of entries) list.append(factRow(entry));
		memoryBody.replaceChildren(list);
		forgetAll.hidden = false;
	}

	async function loadChoices() {
		const mine = generation;
		choicesRetry.hidden = true;
		say(choicesStatus, "");
		choices = null;
		renderSwitches();
		try {
			const response = await getConsent();
			if (mine !== generation) return;
			choices = choicesOf(response);
		} catch {
			if (mine !== generation) return;
			say(choicesStatus, t("privacyChoicesFailed"), "error");
			choicesRetry.hidden = false;
		}
		renderSwitches();
		// The empty-state wording depends on whether memory is on.
		if (memoryState === "ready") renderMemory();
	}

	async function loadMemory(focusAfter = false) {
		const mine = generation;
		memoryState = "loading";
		say(memoryStatus, "");
		renderMemory();
		try {
			const list = await listMemory();
			if (mine !== generation) return;
			entries = list;
			memoryState = "ready";
		} catch {
			if (mine !== generation) return;
			memoryState = "error";
		}
		renderMemory();
		// The Retry button that was pressed is gone; keep focus in the section.
		if (focusAfter) focusSection(memorySection);
	}

	async function save(next: ConsentUpdate): Promise<boolean> {
		const mine = generation;
		saving = true;
		renderSwitches();
		say(choicesStatus, "");
		try {
			const response = await putConsent(next);
			if (mine !== generation) return false;
			choices = choicesOf(response);
			say(choicesStatus, t("privacySettingSaved"), "ok");
			return true;
		} catch {
			if (mine !== generation) return false;
			say(choicesStatus, t("privacySettingFailed"), "error");
			return false;
		} finally {
			if (mine === generation) {
				saving = false;
				renderSwitches();
			}
		}
	}

	history.input.addEventListener("change", async () => {
		if (!choices) return;
		await save({ history: history.input.checked, memory: choices.memory });
		history.input.focus();
	});

	memory.input.addEventListener("change", async () => {
		if (!choices) return;
		if (memory.input.checked) {
			await save({ history: choices.history, memory: true });
			if (memoryState === "ready") renderMemory();
			memory.input.focus();
			return;
		}
		// Off forgets everything. Put the switch back until they confirm.
		memory.input.checked = true;
		say(choicesStatus, "");
		memoryOff.show();
		renderSwitches();
	});

	async function turnMemoryOff() {
		if (!choices) return;
		memoryOff.hide();
		const ok = await save({ history: choices.history, memory: false });
		if (ok) {
			// The server forgot every fact along with the switch.
			entries = [];
			memoryState = "ready";
			renderMemory();
			say(choicesStatus, t("privacyMemoryOffDone"), "ok");
		}
		memory.input.focus();
	}

	async function doForget(id: string, trigger: HTMLButtonElement) {
		trigger.disabled = true;
		say(memoryStatus, "");
		const mine = generation;
		const ok = await forgetFact(id);
		if (mine !== generation) return;
		if (!ok) {
			trigger.disabled = false;
			say(memoryStatus, t("memoryForgetFailed"), "error");
			trigger.focus();
			return;
		}
		const index = entries.findIndex((e) => e.id === id);
		entries = entries.filter((e) => e.id !== id);
		renderMemory();
		say(memoryStatus, t("memoryForgot"), "ok");
		// Focus the row that took its place, or the section once it is empty.
		const buttons = memoryBody.querySelectorAll<HTMLButtonElement>(".memory-forget");
		const next = buttons[Math.min(index, buttons.length - 1)];
		if (next) next.focus();
		else focusSection(memorySection);
	}

	async function doForgetAll() {
		forgetAllConfirm.yes.disabled = true;
		const mine = generation;
		const ok = await forgetAllMemory();
		if (mine !== generation) return;
		forgetAllConfirm.yes.disabled = false;
		if (!ok) {
			forgetAllConfirm.hide();
			forgetAll.hidden = false;
			say(memoryStatus, t("memoryForgetAllFailed"), "error");
			forgetAll.focus();
			return;
		}
		entries = [];
		renderMemory();
		say(memoryStatus, t("memoryForgotAll"), "ok");
		focusSection(memorySection);
	}

	async function doDeleteAll() {
		deleteConfirm.yes.disabled = true;
		const mine = generation;
		const ok = await deleteAllConversations();
		if (mine !== generation) return;
		deleteConfirm.yes.disabled = false;
		deleteConfirm.hide();
		deleteAll.hidden = false;
		if (!ok) {
			say(historyStatus, t("historyDeleteFailed"), "error");
			deleteAll.focus();
			return;
		}
		say(historyStatus, t("historyDeleted"), "ok");
		window.dispatchEvent(new CustomEvent(HISTORY_DELETED_EVENT));
		deleteAll.focus();
	}

	/** Park focus on a section's heading, so it is not lost to <body>. */
	function focusSection(target: HTMLElement) {
		const heading = target.querySelector<HTMLElement>(".privacy-section-title");
		if (!heading) return;
		heading.tabIndex = -1;
		heading.focus();
	}

	function resetView() {
		generation++;
		choices = null;
		entries = [];
		memoryState = "loading";
		saving = false;
		memoryOff.hide();
		forgetAllConfirm.hide();
		deleteConfirm.hide();
		deleteAll.hidden = false;
		choicesRetry.hidden = true;
		for (const s of [choicesStatus, memoryStatus, historyStatus]) say(s, "");
		renderSwitches();
		renderMemory();
	}

	function open() {
		resetView();
		showModal(dialog);
		closeButton.focus();
		void loadChoices();
		void loadMemory();
	}

	function close() {
		closeModal(dialog);
	}

	dialog.addEventListener("close", () => {
		// Nothing half-confirmed survives a close.
		memoryOff.hide();
		forgetAllConfirm.hide();
		deleteConfirm.hide();
		options.onClose?.();
	});

	// A click on the backdrop lands on the dialog itself (the panel fills it).
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) close();
	});

	resetView();

	return {
		element: dialog,
		open,
		close,
		reset() {
			resetView();
			if (dialog.open) close();
		},
	};
}
