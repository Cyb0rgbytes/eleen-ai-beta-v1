import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsDocument, PublicModel } from "../../../src/shared/models";
import { initPicker, type PickerOptions } from "./picker";

function model(partial: Partial<PublicModel> & Pick<PublicModel, "id" | "label" | "tier">): PublicModel {
	return {
		provider: "workers-ai",
		billing: "owner",
		vision: false,
		reasoning: false,
		maxTokens: { guest: 512, user: 1024 },
		contextWindow: 32_000,
		access: "guest",
		...partial,
	};
}

const DOC: ModelsDocument = {
	default: "@cf/fast",
	tiers: ["fast", "smart", "reasoning"],
	models: [
		model({ id: "@cf/fast", label: "Llama 3.1 8B", tier: "fast" }),
		model({ id: "@cf/smart", label: "Llama 3.3 70B", tier: "smart" }),
		model({ id: "@cf/r1", label: "DeepSeek R1 32B", tier: "reasoning", reasoning: true, access: "sign-in" }),
		model({ id: "openai/gpt-5.5", label: "GPT-5.5", tier: "smart", provider: "openai", billing: "user-key", access: "key-required" }),
		model({
			id: "anthropic/claude",
			label: '<img src=x onerror="window.__xss=1">',
			tier: "smart",
			provider: "anthropic",
			billing: "user-key",
			access: "key-required",
		}),
	],
};

/** The picker markup from web/index.html, built with DOM calls. */
function mount(): HTMLElement {
	const make = (tag: string, className: string, attrs: Record<string, string> = {}) => {
		const node = document.createElement(tag);
		node.className = className;
		for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
		return node;
	};
	const root = make("div", "model-picker", { id: "model-picker" });
	const trigger = make("button", "model-trigger", { type: "button" });
	trigger.textContent = "Fast";
	const popover = make("div", "model-popover", { hidden: "" });
	const list = make("div", "model-list", { role: "listbox" });
	const modes = make("div", "mode-segment", { role: "radiogroup" });
	for (const mode of ["balanced", "creative", "logical"]) {
		const b = make("button", mode === "balanced" ? "mode-btn active" : "mode-btn", { "data-mode": mode, type: "button" });
		b.textContent = mode;
		modes.append(b);
	}
	const link = make("button", "model-keys-link", { type: "button", hidden: "" });
	popover.append(list, modes, link);
	root.append(trigger, popover);
	document.body.replaceChildren(root);
	return root;
}

function setup(overrides: Partial<PickerOptions> = {}) {
	const root = mount();
	const calls = {
		model: [] as [string, string][],
		mode: [] as string[],
		signIn: 0,
		keys: [] as (string | undefined)[],
	};
	const picker = initPicker(root, {
		onModelChange: (m, label) => calls.model.push([m, label]),
		onModeChange: (m) => calls.mode.push(m),
		openSignIn: () => calls.signIn++,
		openKeys: (p) => calls.keys.push(p),
		loadModels: async () => structuredClone(DOC),
		...overrides,
	});
	const trigger = root.querySelector(".model-trigger") as HTMLButtonElement;
	const listbox = root.querySelector("[role='listbox']") as HTMLElement;
	const popover = root.querySelector(".model-popover") as HTMLElement;
	const key = (k: string) => listbox.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
	const options = () => [...listbox.querySelectorAll<HTMLElement>("[role='option']")];
	const option = (label: string) => options().find((o) => o.querySelector(".model-option-label")?.textContent === label);
	return { root, picker, calls, trigger, listbox, popover, key, options, option };
}

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	document.body.replaceChildren();
	document.documentElement.dir = "ltr";
});

describe("model picker", () => {
	it("lists the three tiers, then the premium models locked for a guest", async () => {
		const { picker, options, option } = setup();
		await picker.ready;
		expect(options()).toHaveLength(5);
		expect(option("Fast")?.querySelector(".model-option-detail")?.textContent).toBe("Llama 3.1 8B");
		expect(option("Reasoning")?.dataset.lock).toBe("sign-in");
		expect(option("GPT-5.5")?.dataset.lock).toBe("sign-in");
		expect(option("GPT-5.5")?.querySelector(".model-option-lock")?.textContent).toBe("Sign in");
		expect(option("Fast")?.getAttribute("aria-selected")).toBe("true");
	});

	it("reports Fast as the starting model", async () => {
		const { picker, calls } = setup();
		await picker.ready;
		expect(calls.model[0]).toEqual(["fast", "Fast"]);
	});

	it("puts a hostile model label on the page as text", async () => {
		const { picker, root } = setup();
		await picker.ready;
		expect(root.querySelector("img")).toBeNull();
		expect(root.textContent).toContain('<img src=x onerror="window.__xss=1">');
	});

	it("opens on the trigger, moves with the arrows, picks with Enter, and returns focus", async () => {
		const { picker, calls, trigger, listbox, popover, key } = setup();
		await picker.ready;
		trigger.click();
		expect(popover.hidden).toBe(false);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(listbox);
		expect(listbox.getAttribute("aria-activedescendant")).toBe("model-option-0");

		key("ArrowDown");
		expect(listbox.getAttribute("aria-activedescendant")).toBe("model-option-1");
		key("End");
		expect(listbox.getAttribute("aria-activedescendant")).toBe("model-option-4");
		key("Home");
		key("ArrowDown");
		key("Enter");

		expect(calls.model.at(-1)).toEqual(["smart", "Smart"]);
		expect(popover.hidden).toBe(true);
		expect(document.activeElement).toBe(trigger);
		expect(trigger.textContent).toBe("Smart");
	});

	it("closes on Escape and returns focus to the trigger", async () => {
		const { picker, trigger, popover, key } = setup();
		await picker.ready;
		trigger.click();
		key("Escape");
		expect(popover.hidden).toBe(true);
		expect(document.activeElement).toBe(trigger);
	});

	it("sends a guest on a locked row to sign-in, without selecting it", async () => {
		const { picker, calls, option } = setup();
		await picker.ready;
		picker.open();
		option("Reasoning")?.click();
		expect(calls.signIn).toBe(1);
		expect(picker.selected()).toBe("fast");
	});

	it("sends a signed-in user without a key to the keys form for that provider", async () => {
		const { picker, calls, option } = setup();
		await picker.ready;
		picker.setSignedIn(true);
		expect(option("Reasoning")?.dataset.lock).toBeUndefined();
		expect(option("GPT-5.5")?.querySelector(".model-option-lock")?.textContent).toBe("Add your key");
		picker.open();
		option("GPT-5.5")?.click();
		expect(calls.keys).toEqual(["openai"]);
		expect(picker.selected()).toBe("fast");
	});

	it("unlocks a premium model once its key is stored, and falls back when it is removed", async () => {
		const { picker, calls, option } = setup();
		await picker.ready;
		picker.setSignedIn(true);
		picker.setKeys(new Set(["openai"]));
		picker.open();
		option("GPT-5.5")?.click();
		expect(calls.model.at(-1)).toEqual(["openai/gpt-5.5", "GPT-5.5"]);

		picker.setKeys(new Set());
		expect(calls.model.at(-1)).toEqual(["fast", "Fast"]);
		picker.setKeys(new Set(["openai"]));
		expect(calls.model.at(-1)).toEqual(["openai/gpt-5.5", "GPT-5.5"]);
	});

	it("keeps a remembered Reasoning choice until sign-in unlocks it", async () => {
		window.localStorage.setItem("eleen.model", "reasoning");
		const { picker, calls } = setup();
		await picker.ready;
		expect(picker.selected()).toBe("fast");
		picker.setSignedIn(true);
		expect(calls.model.at(-1)).toEqual(["reasoning", "Reasoning"]);
	});

	it("never remembers a premium model", async () => {
		const { picker, option } = setup();
		await picker.ready;
		picker.setSignedIn(true);
		picker.setKeys(new Set(["openai"]));
		picker.open();
		option("GPT-5.5")?.click();
		expect(window.localStorage.getItem("eleen.model")).toBeNull();
	});

	it("still offers the tiers when the listing cannot load", async () => {
		const { picker, options, root } = setup({ loadModels: async () => Promise.reject(new Error("offline")) });
		await picker.ready;
		expect(options().map((o) => o.dataset.value)).toEqual(["fast", "smart", "reasoning"]);
		expect(root.querySelector(".model-list-note")?.textContent).toBe("The full model list could not load.");
	});

	it("shows Manage API keys only when signed in", async () => {
		const { picker, root, calls } = setup();
		await picker.ready;
		const link = root.querySelector(".model-keys-link") as HTMLButtonElement;
		expect(link.hidden).toBe(true);
		picker.setSignedIn(true);
		expect(link.hidden).toBe(false);
		link.click();
		expect(calls.keys).toEqual([undefined]);
	});
});

describe("response modes", () => {
	it("is a radio group that keeps .mode-btn for WebMCP", async () => {
		const { picker, root, calls } = setup();
		await picker.ready;
		const creative = root.querySelector('.mode-btn[data-mode="creative"]') as HTMLButtonElement;
		expect(creative.getAttribute("role")).toBe("radio");
		creative.click();
		expect(calls.mode).toEqual(["creative"]);
		expect(creative.getAttribute("aria-checked")).toBe("true");
		expect(creative.classList.contains("active")).toBe(true);
		expect(root.querySelector('.mode-btn[data-mode="balanced"]')?.getAttribute("aria-checked")).toBe("false");
	});

	it("moves with the arrows in reading direction", async () => {
		const { picker, root, calls } = setup();
		await picker.ready;
		const balanced = root.querySelector('.mode-btn[data-mode="balanced"]') as HTMLButtonElement;
		balanced.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		expect(calls.mode.at(-1)).toBe("creative");

		document.documentElement.dir = "rtl";
		const creative = root.querySelector('.mode-btn[data-mode="creative"]') as HTMLButtonElement;
		creative.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		expect(calls.mode.at(-1)).toBe("balanced");
	});
});

describe("isolation", () => {
	it("does not need the network when a loader is injected", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { picker } = setup();
		await picker.ready;
		expect(fetchSpy).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
