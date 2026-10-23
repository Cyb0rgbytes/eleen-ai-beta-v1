/**
 * Sidebar search (M4.4): GET /api/v1/search as the user types.
 *
 * Debounced 250 ms, at least two characters, and every new query aborts
 * the one before, so a slow answer never overwrites a newer one. While a
 * query is active its results replace the sections.
 *
 * Snippets are plain text from the server, but they are still user and
 * model text: the query terms are marked by splitting the string into text
 * nodes and <mark> elements, never by parsing it as HTML.
 */
import type { SearchHit } from "../../../src/shared/history";
import { ApiError } from "../api/client";
import { t } from "../i18n";

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MIN_CHARS = 2;
const MAX_QUERY = 200;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` as text nodes, with every query term wrapped in a <mark>. */
export function highlight(text: string, query: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
	if (!terms.length) {
		fragment.append(document.createTextNode(text));
		return fragment;
	}
	const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "giu");
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const start = match.index ?? 0;
		if (!match[0]) continue;
		if (start > last) fragment.append(document.createTextNode(text.slice(last, start)));
		const mark = document.createElement("mark");
		mark.textContent = match[0];
		fragment.append(mark);
		last = start + match[0].length;
	}
	if (last < text.length) fragment.append(document.createTextNode(text.slice(last)));
	return fragment;
}

export interface SearchOptions {
	input: HTMLInputElement;
	results: HTMLElement;
	search(q: string, signal: AbortSignal): Promise<SearchHit[]>;
	/** A hit was chosen. */
	onOpen(hit: SearchHit): void;
	/** True while a query is active and results replace the sections. */
	onActiveChange(active: boolean): void;
}

export interface SidebarSearch {
	clear(): void;
	isActive(): boolean;
}

export function createSearch(options: SearchOptions): SidebarSearch {
	const { input, results } = options;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | null = null;
	let active = false;

	results.hidden = true;

	function setActive(next: boolean) {
		if (next === active) return;
		active = next;
		results.hidden = !next;
		options.onActiveChange(next);
	}

	function state(text: string, kind: "empty" | "error" | "loading") {
		const p = document.createElement("p");
		p.className = `sidebar-state is-${kind}`;
		p.textContent = text;
		if (kind !== "loading") p.setAttribute("role", "status");
		results.replaceChildren(p);
	}

	function render(hits: SearchHit[], query: string) {
		if (!hits.length) {
			state(t("searchNoResults", { query }), "empty");
			return;
		}
		const list = document.createElement("ul");
		list.className = "sidebar-list sidebar-hits";
		list.setAttribute("aria-label", t("searchChats"));
		for (const hit of hits) {
			const li = document.createElement("li");
			const button = document.createElement("button");
			button.type = "button";
			button.className = "sidebar-hit";
			button.dataset.conversationId = hit.conversationId;
			button.dataset.messageId = hit.messageId;
			const title = document.createElement("span");
			title.className = "sidebar-hit-title";
			title.append(highlight(hit.title || t("untitledChat"), query));
			const snippet = document.createElement("span");
			snippet.className = "sidebar-hit-snippet";
			snippet.append(highlight(hit.snippet, query));
			button.append(title, snippet);
			button.addEventListener("click", () => options.onOpen(hit));
			li.append(button);
			list.append(li);
		}
		results.replaceChildren(list);
	}

	async function run(query: string) {
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		try {
			const hits = await options.search(query, mine.signal);
			if (controller !== mine) return;
			render(hits, query);
		} catch (error) {
			if (controller !== mine || mine.signal.aborted) return;
			if (error instanceof ApiError && error.kind === "aborted") return;
			state(t("searchFailed"), "error");
		}
	}

	function onInput() {
		clearTimeout(timer);
		const query = input.value.trim().slice(0, MAX_QUERY);
		if (query.length < SEARCH_MIN_CHARS) {
			controller?.abort();
			controller = null;
			results.replaceChildren();
			setActive(false);
			return;
		}
		setActive(true);
		timer = setTimeout(() => void run(query), SEARCH_DEBOUNCE_MS);
	}

	function clear() {
		clearTimeout(timer);
		controller?.abort();
		controller = null;
		input.value = "";
		results.replaceChildren();
		setActive(false);
	}

	input.maxLength = MAX_QUERY;
	input.addEventListener("input", onInput);
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || !input.value) return;
		// Escape clears first; a second one may close the drawer.
		event.preventDefault();
		event.stopPropagation();
		clear();
	});

	return { clear, isActive: () => active };
}
