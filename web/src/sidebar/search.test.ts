import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../../../src/shared/history";
import { createSearch, highlight, SEARCH_DEBOUNCE_MS } from "./search";

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

function holder(fragment: DocumentFragment): HTMLElement {
	const div = document.createElement("div");
	div.append(fragment);
	return div;
}

describe("highlight", () => {
	it("marks every query term, case-insensitively, as text", () => {
		const out = holder(highlight("Tea and more TEA, then coffee", "tea coffee"));
		expect([...out.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Tea", "TEA", "coffee"]);
		expect(out.textContent).toBe("Tea and more TEA, then coffee");
	});

	it("keeps a snippet that looks like HTML as text", () => {
		const snippet = '<img src=x onerror="window.__xss=1"> img here';
		const out = holder(highlight(snippet, "img"));
		expect(out.querySelector("img")).toBeNull();
		expect(out.textContent).toBe(snippet);
		expect(out.querySelectorAll("mark")).toHaveLength(2);
		expect(out.querySelector("mark")?.childElementCount).toBe(0);
	});

	it("treats regex characters in the query literally", () => {
		const out = holder(highlight("costs $5 (approx.)", "(approx.)"));
		expect(out.querySelector("mark")?.textContent).toBe("(approx.)");
	});
});

describe("createSearch", () => {
	const hit = (snippet: string): SearchHit => ({ conversationId: "c1", messageId: "m1", title: "Chat", snippet, createdAt: 1 });

	function setup(search: (q: string, signal: AbortSignal) => Promise<SearchHit[]>) {
		const input = document.createElement("input");
		const results = document.createElement("div");
		document.body.append(input, results);
		const onOpen = vi.fn();
		const onActiveChange = vi.fn();
		const s = createSearch({ input, results, search, onOpen, onActiveChange });
		const type = (value: string) => {
			input.value = value;
			input.dispatchEvent(new Event("input"));
		};
		return { input, results, onOpen, onActiveChange, s, type };
	}

	it("waits 250 ms, needs two characters, and aborts the previous query", async () => {
		vi.useFakeTimers();
		const signals: AbortSignal[] = [];
		const search = vi.fn(async (q: string, signal: AbortSignal) => {
			signals.push(signal);
			return [hit(`about ${q}`)];
		});
		const ui = setup(search);
		ui.type("a");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		expect(search).not.toHaveBeenCalled();
		expect(ui.onActiveChange).not.toHaveBeenCalled();

		ui.type("te");
		ui.type("tea");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
		expect(search).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(search).toHaveBeenCalledTimes(1);
		expect(search).toHaveBeenLastCalledWith("tea", expect.any(AbortSignal));
		expect(ui.onActiveChange).toHaveBeenLastCalledWith(true);
		await vi.waitFor(() => expect(ui.results.querySelector(".sidebar-hit mark")?.textContent).toBe("tea"));

		ui.type("teas");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		ui.type("teapot");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		expect(signals[1]?.aborted).toBe(true);
		expect(signals[2]?.aborted).toBe(false);

		ui.results.querySelector<HTMLButtonElement>(".sidebar-hit")?.click();
		expect(ui.onOpen).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "c1", messageId: "m1" }));
	});

	it("shows no-results and failure states, and Escape clears", async () => {
		vi.useFakeTimers();
		let fail = false;
		const ui = setup(async () => {
			if (fail) throw new Error("down");
			return [];
		});
		ui.type("zzz");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		await vi.waitFor(() => expect(ui.results.textContent).toBe('No chats match "zzz".'));
		fail = true;
		ui.type("zzzz");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		await vi.waitFor(() => expect(ui.results.textContent).toBe("Search is unavailable right now."));

		ui.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(ui.input.value).toBe("");
		expect(ui.results.hidden).toBe(true);
		expect(ui.s.isActive()).toBe(false);
		expect(ui.onActiveChange).toHaveBeenLastCalledWith(false);
	});
});
