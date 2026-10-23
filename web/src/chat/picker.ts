/**
 * The model picker (DESIGN.md section 7).
 *
 * A trigger at the composer's leading edge shows the current choice. Its
 * popover is a role="listbox" of the three tiers from /api/v1/models, then
 * the premium models with a lock and the reason they are locked, then the
 * response modes as a segmented control.
 *
 * - A tier row sends its tier name as `model`, which the server resolves to
 *   that tier's owner-billed model. If the listing cannot load, the tiers
 *   still work, because tier names need no listing.
 * - A locked row does not select: a guest gets the sign-in modal, a
 *   signed-in user gets the keys form for that provider.
 * - Keyboard: the listbox owns focus and points at the active row with
 *   aria-activedescendant. Arrows and Home/End move, Enter or Space picks,
 *   Escape closes and returns focus to the trigger, Tab moves on to the
 *   modes.
 *
 * Every label from the listing reaches the page as textContent.
 */
import type { ResponseMode } from "../../../src/shared/chat";
import type { ModelTier, ModelsDocument, PublicModel } from "../../../src/shared/models";
import { fetchModels } from "../api/client";
import { t, type MessageKey } from "../i18n";
import { PROVIDER_NAMES, isKeyProvider, type KeyProvider } from "../keys/api";
import { icon } from "../ui/icons";

const TIERS: readonly ModelTier[] = ["fast", "smart", "reasoning"];
const MODES: readonly ResponseMode[] = ["balanced", "creative", "logical"];

const TIER_TEXT: Record<ModelTier, { label: MessageKey; note: MessageKey }> = {
	fast: { label: "tierFast", note: "tierFastNote" },
	smart: { label: "tierSmart", note: "tierSmartNote" },
	reasoning: { label: "tierReasoning", note: "tierReasoningNote" },
};

const MODE_TEXT: Record<ResponseMode, MessageKey> = {
	balanced: "modeBalanced",
	creative: "modeCreative",
	logical: "modeLogical",
};

/** Only a tier choice is remembered; premium access is re-checked each visit. */
const STORAGE_KEY = "eleen.model";

export type Lock = "sign-in" | "key-required" | null;

interface Row {
	value: string;
	label: string;
	note: string;
	detail: string;
	lock: Lock;
	provider?: KeyProvider;
}

export interface CompareOption {
	/** Sent in `compare`: a tier name or a premium model id. */
	value: string;
	/** The model's own name, which is what a compare lane is headed with. */
	name: string;
	/** The tier or provider, as the picker shows it. */
	detail: string;
	lock: Lock;
}

export interface PickerOptions {
	onModelChange(model: string, label: string): void;
	onModeChange(mode: ResponseMode): void;
	openSignIn(): void;
	openKeys(provider?: KeyProvider): void;
	/** Injected for tests; defaults to the real listing. */
	loadModels?: () => Promise<ModelsDocument>;
}

export interface Picker {
	setSignedIn(signedIn: boolean): void;
	setKeys(providers: ReadonlySet<KeyProvider>): void;
	open(): void;
	close(options?: { restoreFocus?: boolean }): void;
	focusTrigger(): void;
	selected(): string;
	/** Compare (M5.4): every row as a choice, with the name its lane shows and any lock. */
	choices(): CompareOption[];
	/** A model id's display name from the listing, or null before it loads. */
	labelFor(modelId: string): string | null;
	/** Resolves once the listing has loaded or failed. */
	readonly ready: Promise<void>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

function readStored(): string | null {
	try {
		return window.localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeStored(value: string): void {
	try {
		if ((TIERS as readonly string[]).includes(value)) window.localStorage.setItem(STORAGE_KEY, value);
	} catch {
		// Storage is a convenience; private windows may refuse it.
	}
}

/** Keep only listing entries with the fields the picker shows. */
function usable(model: unknown): model is PublicModel {
	if (typeof model !== "object" || model === null) return false;
	const m = model as Record<string, unknown>;
	return typeof m.id === "string" && typeof m.label === "string" && typeof m.tier === "string";
}

export function initPicker(root: HTMLElement, options: PickerOptions): Picker {
	const part = <T extends Element>(selector: string): T => {
		const found = root.querySelector<T>(selector);
		if (!found) throw new Error(`Model picker markup is missing ${selector}`);
		return found;
	};
	const trigger = part<HTMLButtonElement>(".model-trigger");
	const popover = part<HTMLElement>(".model-popover");
	const listbox = part<HTMLElement>("[role='listbox']");
	const modeGroup = part<HTMLElement>(".mode-segment");
	const keysLink = root.querySelector<HTMLButtonElement>(".model-keys-link");

	const triggerLabel = el("span", "model-trigger-label");
	trigger.replaceChildren(triggerLabel, icon("caret-down"));
	listbox.setAttribute("aria-label", t("modelPicker"));
	listbox.tabIndex = 0;
	modeGroup.setAttribute("aria-label", t("responseMode"));

	let doc: ModelsDocument | null = null;
	let failed = false;
	let signedIn = false;
	let keys: ReadonlySet<KeyProvider> = new Set();
	const stored = readStored();
	let selected = stored && (TIERS as readonly string[]).includes(stored) ? stored : "fast";
	let rows: Row[] = [];
	let active = 0;

	function tierRows(): Row[] {
		return TIERS.map((tier) => {
			const owner = doc?.models.find((m) => m.tier === tier && m.billing === "owner");
			// Without the listing, fall back to what the docs promise: the
			// reasoning tier is for signed-in users.
			const needsSignIn = owner ? owner.access === "sign-in" : tier === "reasoning";
			return {
				value: tier,
				label: t(TIER_TEXT[tier].label),
				note: t(TIER_TEXT[tier].note),
				detail: owner?.label ?? "",
				lock: needsSignIn && !signedIn ? "sign-in" : null,
			};
		});
	}

	function premiumRows(): Row[] {
		if (!doc) return [];
		return doc.models
			.filter((m) => m.billing === "user-key" && isKeyProvider(m.provider))
			.map((m) => {
				const provider = m.provider as KeyProvider;
				const lock: Lock = !signedIn ? "sign-in" : keys.has(provider) ? null : "key-required";
				return { value: m.id, label: m.label, note: "", detail: PROVIDER_NAMES[provider], lock, provider };
			});
	}

	function labelFor(value: string): string {
		return rows.find((r) => r.value === value)?.label ?? t(TIER_TEXT.fast.label);
	}

	function optionId(index: number): string {
		return `model-option-${index}`;
	}

	function renderOption(row: Row, index: number, current: string): HTMLElement {
		const option = el("div", "model-option");
		option.id = optionId(index);
		option.setAttribute("role", "option");
		option.setAttribute("aria-selected", String(row.value === current));
		option.dataset.value = row.value;
		option.dataset.index = String(index);
		if (row.lock) option.dataset.lock = row.lock;

		const text = el("span", "model-option-text");
		const label = el("span", "model-option-label");
		label.textContent = row.label;
		text.append(label);
		if (row.note) {
			const note = el("span", "model-option-note");
			note.textContent = row.note;
			text.append(note);
		}
		option.append(text);

		const side = el("span", "model-option-side");
		if (row.lock) {
			side.append(icon("lock-simple"));
			const reason = el("span", "model-option-lock");
			reason.textContent = row.lock === "sign-in" ? t("lockedSignIn") : t("lockedAddKey");
			side.append(reason);
		} else if (row.value === current) {
			side.append(icon("check"));
		}
		if (row.detail) {
			const detail = el("span", "model-option-detail");
			detail.textContent = row.detail;
			side.prepend(detail);
		}
		option.append(side);
		return option;
	}

	/**
	 * What is actually sent. `selected` is the person's choice; while that is
	 * locked (auth still loading, signed out, key removed) Fast stands in,
	 * and the choice comes back by itself once it unlocks.
	 */
	function effective(): string {
		const row = rows.find((r) => r.value === selected);
		return row && !row.lock ? selected : "fast";
	}

	let reported = "";
	function report() {
		const value = effective();
		if (value === reported) return;
		reported = value;
		options.onModelChange(value, labelFor(value));
	}

	function render() {
		rows = [...tierRows(), ...premiumRows()];
		const current = effective();

		const tiers = el("div", "model-group");
		tiers.setAttribute("role", "group");
		tiers.setAttribute("aria-label", t("modelPicker"));
		const premium = el("div", "model-group is-premium");
		premium.setAttribute("role", "group");
		const head = el("div", "model-group-head");
		head.id = "model-premium-head";
		head.textContent = t("premiumModels");
		premium.setAttribute("aria-labelledby", head.id);
		premium.append(head);

		rows.forEach((row, index) => {
			(row.provider ? premium : tiers).append(renderOption(row, index, current));
		});
		const parts: HTMLElement[] = [tiers];
		if (premium.childElementCount > 1) parts.push(premium);
		if (failed) {
			const note = el("p", "model-list-note");
			note.textContent = t("modelsUnavailable");
			parts.push(note);
		}
		listbox.replaceChildren(...parts);
		if (keysLink) keysLink.hidden = !signedIn;

		triggerLabel.textContent = labelFor(current);
		trigger.setAttribute("aria-label", t("modelTriggerLabel", { model: labelFor(current) }));
		setActive(Math.min(active, rows.length - 1));
		report();
	}

	function setActive(index: number) {
		active = Math.max(0, Math.min(index, rows.length - 1));
		for (const option of listbox.querySelectorAll<HTMLElement>("[role='option']")) {
			option.classList.toggle("is-active", option.dataset.index === String(active));
		}
		listbox.setAttribute("aria-activedescendant", optionId(active));
		listbox.querySelector(`#${optionId(active)}`)?.scrollIntoView?.({ block: "nearest" });
	}

	function select(value: string) {
		selected = value;
		writeStored(value);
		render();
	}

	function activate(index: number) {
		const row = rows[index];
		if (!row) return;
		if (row.lock === "sign-in") {
			close({ restoreFocus: true });
			options.openSignIn();
		} else if (row.lock === "key-required") {
			close({ restoreFocus: false });
			options.openKeys(row.provider);
		} else {
			select(row.value);
			close({ restoreFocus: true });
		}
	}

	function isOpen() {
		return !popover.hidden;
	}

	function open() {
		if (isOpen()) return;
		render();
		popover.hidden = false;
		trigger.setAttribute("aria-expanded", "true");
		setActive(Math.max(0, rows.findIndex((r) => r.value === effective())));
		listbox.focus();
	}

	function close({ restoreFocus = true } = {}) {
		if (!isOpen()) return;
		popover.hidden = true;
		trigger.setAttribute("aria-expanded", "false");
		if (restoreFocus) trigger.focus();
	}

	trigger.setAttribute("aria-haspopup", "listbox");
	trigger.setAttribute("aria-expanded", "false");
	trigger.addEventListener("click", () => (isOpen() ? close() : open()));
	trigger.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			open();
		}
	});

	listbox.addEventListener("keydown", (event) => {
		const moves: Record<string, number> = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: rows.length - 1 };
		if (event.key in moves) {
			event.preventDefault();
			setActive(moves[event.key] as number);
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			activate(active);
		}
	});

	listbox.addEventListener("click", (event) => {
		const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[role='option']") : null;
		if (option) activate(Number(option.dataset.index));
	});
	listbox.addEventListener("pointermove", (event) => {
		const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[role='option']") : null;
		if (option && Number(option.dataset.index) !== active) setActive(Number(option.dataset.index));
	});

	// Escape anywhere in the popover closes it, and the composer's own
	// Escape (stop streaming) does not also fire.
	popover.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
		}
	});

	// Outside a click or focus, the popover closes without stealing focus.
	document.addEventListener("pointerdown", (event) => {
		if (isOpen() && event.target instanceof Node && !root.contains(event.target)) close({ restoreFocus: false });
	});
	root.addEventListener("focusout", (event) => {
		const next = event.relatedTarget;
		if (isOpen() && next instanceof Node && !root.contains(next)) close({ restoreFocus: false });
	});

	keysLink?.addEventListener("click", () => {
		close({ restoreFocus: false });
		options.openKeys();
	});
	if (keysLink) {
		keysLink.replaceChildren(icon("key"));
		const label = el("span");
		label.textContent = t("manageKeys");
		keysLink.append(label);
		keysLink.hidden = true;
	}

	// The segmented control: a radio group with a roving tab stop. The
	// buttons keep .mode-btn and data-mode, which WebMCP's set_model clicks.
	const modeButtons = [...modeGroup.querySelectorAll<HTMLButtonElement>(".mode-btn")];
	function setMode(mode: ResponseMode, focus = false) {
		for (const b of modeButtons) {
			const on = b.dataset.mode === mode;
			b.classList.toggle("active", on);
			b.setAttribute("aria-checked", String(on));
			b.tabIndex = on ? 0 : -1;
			if (on && focus) b.focus();
		}
		options.onModeChange(mode);
	}
	for (const b of modeButtons) {
		const mode = b.dataset.mode as ResponseMode;
		if (!MODES.includes(mode)) continue;
		b.type = "button";
		b.setAttribute("role", "radio");
		b.textContent = t(MODE_TEXT[mode]);
		b.addEventListener("click", () => setMode(mode));
		b.addEventListener("keydown", (event) => {
			// Arrow keys follow the reading direction.
			const rtl = document.documentElement.dir === "rtl";
			const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 1, ArrowUp: -1 }[event.key];
			if (!step) return;
			event.preventDefault();
			const index = MODES.indexOf(mode);
			const next = MODES[(index + step + MODES.length) % MODES.length] as ResponseMode;
			setMode(next, true);
		});
	}
	const initialMode = (modeButtons.find((b) => b.classList.contains("active"))?.dataset.mode as ResponseMode) ?? "balanced";
	for (const b of modeButtons) {
		const on = b.dataset.mode === initialMode;
		b.setAttribute("aria-checked", String(on));
		b.tabIndex = on ? 0 : -1;
	}

	render();

	const ready = (options.loadModels ?? (() => fetchModels()))()
		.then((loaded) => {
			doc = { ...loaded, models: Array.isArray(loaded.models) ? loaded.models.filter(usable) : [] };
		})
		.catch(() => {
			failed = true;
		})
		.finally(() => render());

	return {
		setSignedIn(next) {
			if (next === signedIn) return;
			signedIn = next;
			if (!next) keys = new Set();
			render();
		},
		setKeys(next) {
			keys = next;
			render();
		},
		open,
		close,
		focusTrigger: () => trigger.focus(),
		selected: () => effective(),
		choices: () =>
			rows.map((row) => ({
				value: row.value,
				// A tier row is named by its model when the listing has loaded.
				name: row.provider ? row.label : row.detail || row.label,
				detail: row.provider ? row.detail : row.label,
				lock: row.lock,
			})),
		labelFor: (modelId) => doc?.models.find((m) => m.id === modelId)?.label ?? null,
		ready,
	};
}
