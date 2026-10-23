/**
 * The conversation sidebar (M4.4, DESIGN.md section 7).
 *
 * Three modes, chosen by sidebar/index.ts from the history state:
 * - hidden: a guest, or consent not read yet. Nothing shows.
 * - off: signed in with history off. New chat and a hint that opens the
 *   memory-and-privacy panel.
 * - saved: the full sidebar. Search at the top, New chat, then Pinned,
 *   Folders and Recent (grouping rules in store.ts).
 *
 * Data: the first page of GET /api/v1/conversations (every chat, pinned
 * first) on entering saved mode, more pages on "Show more", and each
 * folder's own first page the first time it is expanded, so a folder is
 * complete even when its chats are older than the pages loaded so far. The
 * chat's CONVERSATION_UPDATED_EVENT upserts one row; a finished turn
 * refetches the first page (debounced) to pick up the server's auto-title.
 *
 * Edits are optimistic: the list changes at once, and a failure puts it
 * back with a toast. While a menu or an inline field is open the list is
 * not rebuilt under the user; the change is drawn when they are done.
 *
 * Recently deleted sits collapsed at the bottom: soft-deleted chats from the
 * last DELETED_RETENTION_DAYS, loaded on first expand, each with Restore
 * and Delete forever (an inline confirm). The server purges older ones daily.
 *
 * Every title, folder name and snippet is set with textContent.
 */
import type {
	ConversationList,
	ConversationSummary,
	ConversationUpdate,
	DeletedConversation,
	DeletedConversationList,
	Folder,
	SearchHit,
} from "../../../src/shared/history";
import { DELETED_RETENTION_DAYS } from "../../../src/shared/history";
import * as historyApi from "../history/api";
import {
	CONVERSATION_CHANGED_EVENT,
	CONVERSATION_UPDATED_EVENT,
	type ConversationChangedDetail,
	type ConversationUpdatedDetail,
} from "../history/state";
import { t } from "../i18n";
import { icon } from "../ui/icons";
import { showToast } from "../ui/toast";
import { createDrawer, type Drawer } from "./drawer";
import { closeMenu, isMenuOpen, toggleMenu, type MenuItem } from "./menu";
import { createSearch } from "./search";
import { cleanTitle, groupConversations, sortFolders } from "./store";

/** Fired on window by privacy/panel.ts after "Delete all my conversations". */
export const HISTORY_DELETED_EVENT = "eleen:history-deleted";
const TURN_REFRESH_MS = 1500;
const UNDO_TOAST_MS = 6000;

export type SidebarMode = "hidden" | "off" | "saved";

export interface SidebarApi {
	listConversations(options?: { folder?: string; cursor?: string | null }): Promise<ConversationList>;
	listFolders(): Promise<Folder[]>;
	patchConversation(id: string, update: ConversationUpdate): Promise<ConversationSummary>;
	deleteConversation(id: string): Promise<void>;
	restoreConversation(id: string): Promise<ConversationSummary>;
	listDeletedConversations(options?: { cursor?: string | null }): Promise<DeletedConversationList>;
	purgeConversation(id: string): Promise<void>;
	createFolder(name: string): Promise<Folder>;
	patchFolder(id: string, update: { name?: string }): Promise<Folder>;
	deleteFolder(id: string): Promise<void>;
	search(q: string, signal?: AbortSignal): Promise<SearchHit[]>;
}

export interface SidebarChat {
	newChat(): void;
	openConversation(conversationId: string, leafId?: string): Promise<void>;
	currentConversationId(): string | null;
}

export interface SidebarOptions {
	chat: SidebarChat;
	openPrivacy(): void;
	/** Injected for tests; defaults to web/src/history/api.ts. */
	api?: SidebarApi;
	panel?: HTMLElement;
	toggle?: HTMLButtonElement;
	scrim?: HTMLElement;
	turnRefreshMs?: number;
}

export interface Sidebar {
	setMode(mode: SidebarMode): void;
	mode(): SidebarMode;
	readonly drawer: Drawer;
	readonly panel: HTMLElement;
	/** Hide it and stop listening to the page. */
	destroy(): void;
}

type Status = "idle" | "loading" | "ready" | "error";
type Editing = { kind: "chat" | "folder"; id: string } | { kind: "new-folder" } | null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(className: string, text?: string): HTMLButtonElement {
	const b = el("button", className, text);
	b.type = "button";
	return b;
}

function srLabel(text: string): HTMLSpanElement {
	return el("span", "sr-only", text);
}

const cssEscape = (value: string) => value.replace(/["\\]/g, "\\$&");

const displayTitle = (c: ConversationSummary) => c.title.trim() || t("untitledChat");

function ensure<T extends HTMLElement>(id: string, make: () => T, before?: Node | null): T {
	const found = document.getElementById(id) as T | null;
	if (found) return found;
	const created = make();
	created.id = id;
	document.body.insertBefore(created, before ?? null);
	return created;
}

export function createSidebar(options: SidebarOptions): Sidebar {
	const { chat } = options;
	const api: SidebarApi = options.api ?? historyApi;
	const turnRefreshMs = options.turnRefreshMs ?? TURN_REFRESH_MS;

	const panel = options.panel ?? ensure("sidebar", () => el("aside", "sidebar"));
	const scrim = options.scrim ?? ensure("sidebar-scrim", () => el("div", "sidebar-scrim"), panel);
	const toggle = options.toggle ?? ensure("sidebar-toggle", () => button("sidebar-toggle"), panel.nextSibling);

	// ── Skeleton ───────────────────────────────────────────────────────────
	panel.setAttribute("aria-label", t("sidebarLabel"));
	scrim.setAttribute("aria-hidden", "true");

	const head = el("div", "sidebar-head");
	const searchBox = el("div", "sidebar-search");
	const searchInput = el("input", "sidebar-search-input");
	searchInput.type = "search";
	searchInput.id = "sidebar-search-input";
	searchInput.placeholder = t("searchPlaceholder");
	searchInput.autocomplete = "off";
	const searchLabel = el("label", "sr-only", t("searchChats"));
	searchLabel.htmlFor = searchInput.id;
	searchBox.append(icon("magnifying-glass"), searchLabel, searchInput);
	head.append(searchBox);

	const newChatButton = button("sidebar-new");
	newChatButton.dataset.focusKey = "new-chat";
	newChatButton.append(icon("plus"), el("span", undefined, t("newChat")));

	const body = el("div", "sidebar-body");
	const results = el("div", "sidebar-results");
	const sections = el("div", "sidebar-sections");

	function section(key: "sectionPinned" | "sectionFolders" | "sectionRecent", id: string) {
		const wrap = el("section", `sidebar-section is-${id}`);
		const titleRow = el("div", "sidebar-section-head");
		const heading = el("h2", "sidebar-heading", t(key));
		heading.id = `sidebar-heading-${id}`;
		titleRow.append(heading);
		const list = el("ul", "sidebar-list");
		list.setAttribute("aria-labelledby", heading.id);
		wrap.append(titleRow, list);
		return { wrap, titleRow, list };
	}

	const pinned = section("sectionPinned", "pinned");
	const foldersSection = section("sectionFolders", "folders");
	const recent = section("sectionRecent", "recent");
	const newFolderButton = button("sidebar-icon-button sidebar-new-folder");
	newFolderButton.dataset.focusKey = "new-folder";
	newFolderButton.append(icon("plus"), srLabel(t("folderNew")));
	newFolderButton.title = t("folderNew");
	foldersSection.titleRow.append(newFolderButton);
	const moreButton = button("sidebar-more-chats", t("loadMore"));
	moreButton.dataset.focusKey = "load-more";
	recent.wrap.append(moreButton);
	const state = el("div", "sidebar-state-wrap");

	// Recently deleted: collapsed at the bottom, loaded on first expand.
	const deletedWrap = el("section", "sidebar-section is-deleted");
	const deletedHead = el("div", "sidebar-section-head");
	const deletedToggle = button("sidebar-link sidebar-folder-toggle sidebar-deleted-toggle");
	deletedToggle.dataset.focusKey = "deleted-toggle";
	deletedToggle.setAttribute("aria-expanded", "false");
	deletedToggle.setAttribute("aria-controls", "sidebar-deleted-list");
	deletedToggle.append(icon("caret-down"), el("span", "sidebar-heading", t("sectionDeleted")));
	deletedHead.append(deletedToggle);
	const deletedBody = el("div", "sidebar-deleted-body");
	deletedBody.id = "sidebar-deleted-list";
	deletedBody.hidden = true;
	deletedWrap.append(deletedHead, deletedBody);

	sections.append(pinned.wrap, foldersSection.wrap, recent.wrap, state, deletedWrap);

	const off = el("div", "sidebar-off");
	const offHint = el("p", "sidebar-hint", t("historyOffHint"));
	const offOpen = button("sidebar-text-button", t("historyOffOpen"));
	off.append(offHint, offOpen);

	body.append(results, sections, off);
	panel.replaceChildren(head, newChatButton, body);

	const drawer = createDrawer({
		panel,
		toggle,
		scrim,
		focusTarget: () => (mode === "saved" ? searchInput : newChatButton),
	});

	// ── State ──────────────────────────────────────────────────────────────
	let mode: SidebarMode = "hidden";
	let status: Status = "idle";
	let gen = 0;
	let conversations = new Map<string, ConversationSummary>();
	let folders: Folder[] = [];
	let nextCursor: string | null = null;
	let loadingMore = false;
	const expanded = new Set<string>();
	const folderLoaded = new Set<string>();
	const folderCursor = new Map<string, string>();
	let confirmingFolder: string | null = null;
	let editing: Editing = null;
	let dirty = false;
	let activeId: string | null = chat.currentConversationId();
	let turnTimer: ReturnType<typeof setTimeout> | undefined;
	let deletedOpen = false;
	/** null until first loaded. */
	let deleted: DeletedConversation[] | null = null;
	let deletedCursor: string | null = null;
	let deletedStatus: Status = "idle";
	let confirmingPurge: string | null = null;

	const search = createSearch({
		input: searchInput,
		results,
		search: (q, signal) => api.search(q, signal),
		onOpen: (hit) => openChat(hit.conversationId, hit.messageId),
		onActiveChange: (active) => {
			sections.hidden = active || mode !== "saved";
		},
	});

	function upsert(list: readonly ConversationSummary[]) {
		for (const c of list) conversations.set(c.id, c);
	}

	// ── Rendering ──────────────────────────────────────────────────────────
	function applyMode() {
		head.hidden = mode !== "saved";
		sections.hidden = mode !== "saved" || search.isActive();
		results.hidden = mode !== "saved" || !search.isActive();
		off.hidden = mode !== "off";
	}

	function chatItem(c: ConversationSummary): HTMLLIElement {
		const li = el("li", "sidebar-item");
		li.dataset.id = c.id;
		const row = el("div", "sidebar-row");
		const link = button("sidebar-link");
		link.dataset.focusKey = `link:${c.id}`;
		const title = el("span", "sidebar-title", displayTitle(c));
		link.append(title);
		link.title = displayTitle(c);
		link.addEventListener("click", () => openChat(c.id));
		const more = button("sidebar-icon-button sidebar-more");
		more.dataset.focusKey = `more:${c.id}`;
		more.setAttribute("aria-haspopup", "menu");
		more.setAttribute("aria-expanded", "false");
		more.setAttribute("aria-label", t("chatOptions", { title: displayTitle(c) }));
		more.append(icon("dots-three"));
		more.addEventListener("click", () => toggleMenu(more, row, () => chatMenu(c.id), afterInteraction));
		row.append(link, more);
		li.append(row);
		if (c.id === activeId) {
			li.classList.add("is-active");
			link.setAttribute("aria-current", "page");
		}
		return li;
	}

	function folderItem(folder: Folder, chats: readonly ConversationSummary[]): HTMLLIElement {
		const li = el("li", "sidebar-folder");
		li.dataset.folderId = folder.id;
		const open = expanded.has(folder.id);
		const row = el("div", "sidebar-row");
		const toggleButton = button("sidebar-link sidebar-folder-toggle");
		toggleButton.dataset.focusKey = `folder:${folder.id}`;
		toggleButton.setAttribute("aria-expanded", String(open));
		toggleButton.setAttribute("aria-label", t(open ? "folderCollapse" : "folderExpand", { name: folder.name }));
		toggleButton.append(icon("caret-down"), icon("folder-simple"), el("span", "sidebar-title", folder.name));
		toggleButton.addEventListener("click", () => void toggleFolder(folder.id));
		const more = button("sidebar-icon-button sidebar-more");
		more.dataset.focusKey = `fmore:${folder.id}`;
		more.setAttribute("aria-haspopup", "menu");
		more.setAttribute("aria-expanded", "false");
		more.setAttribute("aria-label", t("chatOptions", { title: folder.name }));
		more.append(icon("dots-three"));
		more.addEventListener("click", () => toggleMenu(more, row, () => folderMenu(folder.id), afterInteraction));
		row.append(toggleButton, more);
		li.append(row);

		if (confirmingFolder === folder.id) {
			const confirm = el("div", "sidebar-confirm");
			confirm.setAttribute("role", "group");
			const text = el("p", "sidebar-confirm-text", t("folderDeleteConfirm", { name: folder.name }));
			text.id = `sidebar-confirm-${folder.id}`;
			confirm.setAttribute("aria-labelledby", text.id);
			const yes = button("sidebar-text-button is-danger", t("folderDelete"));
			yes.dataset.focusKey = `confirm-yes:${folder.id}`;
			yes.addEventListener("click", () => void removeFolder(folder.id));
			const no = button("sidebar-text-button", t("folderCancel"));
			no.dataset.focusKey = `confirm-no:${folder.id}`;
			no.addEventListener("click", () => {
				confirmingFolder = null;
				render({ focus: `folder:${folder.id}` });
			});
			confirm.addEventListener("keydown", (event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				no.click();
			});
			const actions = el("div", "sidebar-confirm-actions");
			actions.append(yes, no);
			confirm.append(text, actions);
			li.append(confirm);
		}

		const list = el("ul", "sidebar-list sidebar-folder-items");
		list.hidden = !open;
		if (open) {
			if (chats.length) list.append(...chats.map(chatItem));
			else if (folderLoaded.has(folder.id)) list.append(el("li", "sidebar-empty", t("folderEmpty")));
			const cursor = folderCursor.get(folder.id);
			if (cursor) {
				const li2 = el("li");
				const more2 = button("sidebar-more-chats", t("loadMore"));
				more2.dataset.focusKey = `folder-more:${folder.id}`;
				more2.addEventListener("click", () => void loadFolder(folder.id, cursor));
				li2.append(more2);
				list.append(li2);
			}
		}
		li.append(list);
		return li;
	}

	function stateMessage(): HTMLElement | null {
		if (status === "error") {
			const wrap = el("div", "sidebar-state is-error");
			wrap.setAttribute("role", "alert");
			const retry = button("sidebar-text-button", t("chatsRetry"));
			retry.dataset.focusKey = "retry";
			retry.addEventListener("click", () => void load());
			wrap.append(el("p", undefined, t("chatsLoadFailed")), retry);
			return wrap;
		}
		if (status === "ready" && conversations.size === 0) return el("p", "sidebar-state is-empty", t("chatsEmpty"));
		return null;
	}

	/** Rebuild the sections, keeping focus on the same control when it survives. */
	function render(opts: { focus?: string; force?: boolean } = {}) {
		if (mode !== "saved") return;
		if (!opts.force && (isMenuOpen() || editing)) {
			dirty = true;
			return;
		}
		dirty = false;
		const focused = document.activeElement as HTMLElement | null;
		const keepFocus = opts.focus ?? (focused && sections.contains(focused) ? focused.dataset.focusKey : undefined);

		const groups = groupConversations(conversations.values(), folders);
		const ready = status === "ready";
		sections.setAttribute("aria-busy", String(status === "loading"));

		pinned.list.replaceChildren(...groups.pinned.map(chatItem));
		pinned.wrap.hidden = !groups.pinned.length;

		foldersSection.list.replaceChildren(...folders.map((f) => folderItem(f, groups.byFolder.get(f.id) ?? [])));
		if (editing?.kind === "new-folder") foldersSection.list.prepend(newFolderRow());
		foldersSection.wrap.hidden = !ready;

		recent.list.replaceChildren(...groups.recent.map(chatItem));
		recent.wrap.hidden = !groups.recent.length && !nextCursor;
		moreButton.hidden = !nextCursor;
		moreButton.disabled = loadingMore;

		const message = stateMessage();
		state.replaceChildren(...(message ? [message] : []));

		renderDeleted(ready);

		if (keepFocus) panel.querySelector<HTMLElement>(`[data-focus-key="${cssEscape(keepFocus)}"]`)?.focus();
	}

	function deletedItem(c: DeletedConversation): HTMLLIElement {
		const li = el("li", "sidebar-item sidebar-deleted-item");
		li.dataset.deletedId = c.id;
		const name = displayTitle(c);
		const title = el("span", "sidebar-title", name);
		title.title = name;
		const actions = el("div", "sidebar-deleted-actions");
		const restoreButton = button("sidebar-text-button", t("chatRestore"));
		restoreButton.dataset.focusKey = `restore:${c.id}`;
		restoreButton.setAttribute("aria-label", t("chatRestoreLabel", { title: name }));
		restoreButton.addEventListener("click", () => void restoreDeleted(c.id));
		const purgeButton = button("sidebar-text-button is-danger", t("chatDeleteForever"));
		purgeButton.dataset.focusKey = `purge:${c.id}`;
		purgeButton.setAttribute("aria-label", t("chatDeleteForeverLabel", { title: name }));
		purgeButton.addEventListener("click", () => {
			confirmingPurge = c.id;
			render({ focus: `purge-no:${c.id}`, force: true });
		});
		actions.append(restoreButton, purgeButton);
		li.append(title, actions);

		if (confirmingPurge === c.id) {
			const confirm = el("div", "sidebar-confirm");
			confirm.setAttribute("role", "group");
			const text = el("p", "sidebar-confirm-text", t("chatDeleteForeverConfirm", { title: name }));
			text.id = `sidebar-purge-${c.id}`;
			confirm.setAttribute("aria-labelledby", text.id);
			const yes = button("sidebar-text-button is-danger", t("chatDeleteForever"));
			yes.dataset.focusKey = `purge-yes:${c.id}`;
			yes.addEventListener("click", () => void purge(c.id));
			const no = button("sidebar-text-button", t("folderCancel"));
			no.dataset.focusKey = `purge-no:${c.id}`;
			no.addEventListener("click", () => {
				confirmingPurge = null;
				render({ focus: `purge:${c.id}`, force: true });
			});
			confirm.addEventListener("keydown", (event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				no.click();
			});
			const row = el("div", "sidebar-confirm-actions");
			row.append(yes, no);
			confirm.append(text, row);
			li.append(confirm);
		}
		return li;
	}

	function renderDeleted(ready: boolean) {
		deletedWrap.hidden = !ready;
		deletedToggle.setAttribute("aria-expanded", String(deletedOpen));
		deletedBody.hidden = !deletedOpen;
		if (!deletedOpen) return;
		const nodes: HTMLElement[] = [el("p", "sidebar-hint", t("deletedHint", { days: DELETED_RETENTION_DAYS }))];
		if (deletedStatus === "error") {
			const retry = button("sidebar-text-button", t("chatsRetry"));
			retry.dataset.focusKey = "deleted-retry";
			retry.addEventListener("click", () => void loadDeleted());
			nodes.push(el("p", "sidebar-state is-error", t("chatsLoadFailed")), retry);
		} else if (deleted && !deleted.length) {
			nodes.push(el("p", "sidebar-state is-empty", t("deletedEmpty")));
		} else if (deleted) {
			const list = el("ul", "sidebar-list");
			list.setAttribute("aria-label", t("sectionDeleted"));
			list.append(...deleted.map(deletedItem));
			nodes.push(list);
			if (deletedCursor) {
				const more = button("sidebar-more-chats", t("loadMore"));
				more.dataset.focusKey = "deleted-more";
				more.addEventListener("click", () => void loadDeleted(deletedCursor));
				nodes.push(more);
			}
		}
		deletedBody.setAttribute("aria-busy", String(deletedStatus === "loading"));
		deletedBody.replaceChildren(...nodes);
	}

	function afterInteraction() {
		if (dirty && !editing) render();
	}

	function markActive() {
		for (const li of panel.querySelectorAll<HTMLElement>(".sidebar-item")) {
			const on = li.dataset.id === activeId;
			li.classList.toggle("is-active", on);
			const link = li.querySelector(".sidebar-link");
			if (on) link?.setAttribute("aria-current", "page");
			else link?.removeAttribute("aria-current");
		}
	}

	// ── Loading ────────────────────────────────────────────────────────────
	async function load() {
		const mine = ++gen;
		status = "loading";
		render();
		try {
			const [page, folderList] = await Promise.all([api.listConversations(), api.listFolders()]);
			if (mine !== gen) return;
			conversations = new Map(page.conversations.map((c) => [c.id, c]));
			folders = sortFolders(folderList);
			nextCursor = page.nextCursor;
			status = "ready";
		} catch {
			if (mine !== gen) return;
			status = "error";
		}
		render();
	}

	async function loadMore() {
		if (!nextCursor || loadingMore) return;
		const mine = gen;
		loadingMore = true;
		render();
		try {
			const page = await api.listConversations({ cursor: nextCursor });
			if (mine !== gen) return;
			upsert(page.conversations);
			nextCursor = page.nextCursor;
		} catch {
			if (mine === gen) showToast(t("chatsLoadFailed"), "error");
		} finally {
			if (mine === gen) {
				loadingMore = false;
				render({ focus: nextCursor ? "load-more" : undefined });
			}
		}
	}

	/** The first page after a turn: new chats and the server's auto-titles. */
	async function refresh() {
		if (mode !== "saved" || status !== "ready") return;
		const mine = gen;
		try {
			const page = await api.listConversations();
			if (mine !== gen) return;
			upsert(page.conversations);
			render();
		} catch {
			// Quiet: the list is still usable, and the next turn tries again.
		}
	}

	async function loadDeleted(cursor?: string | null) {
		const mine = gen;
		deletedStatus = "loading";
		render();
		try {
			const page = await api.listDeletedConversations({ cursor });
			if (mine !== gen) return;
			const seen = new Set((cursor ? deleted ?? [] : []).map((c) => c.id));
			deleted = [...(cursor ? deleted ?? [] : []), ...page.conversations.filter((c) => !seen.has(c.id))];
			deletedCursor = page.nextCursor;
			deletedStatus = "ready";
		} catch {
			if (mine !== gen) return;
			deletedStatus = "error";
		}
		render({ focus: cursor && deletedCursor ? "deleted-more" : undefined });
	}

	function toggleDeleted() {
		deletedOpen = !deletedOpen;
		confirmingPurge = null;
		render({ focus: "deleted-toggle", force: true });
		if (deletedOpen && deleted === null) void loadDeleted();
	}

	const dropDeleted = (id: string) => {
		if (deleted) deleted = deleted.filter((c) => c.id !== id);
	};

	async function restoreDeleted(id: string) {
		const mine = gen;
		try {
			const fresh = await api.restoreConversation(id);
			if (mine !== gen || mode !== "saved") return;
			dropDeleted(id);
			conversations.set(fresh.id, fresh);
			render({ focus: "deleted-toggle" });
			showToast(t("chatRestored"), "success");
		} catch {
			failed();
		}
	}

	async function purge(id: string) {
		const before = deleted;
		confirmingPurge = null;
		dropDeleted(id);
		render({ focus: "deleted-toggle", force: true });
		try {
			await api.purgeConversation(id);
			showToast(t("chatPurged"), "success");
		} catch {
			deleted = before;
			render();
			failed();
		}
	}

	async function loadFolder(id: string, cursor?: string) {
		const mine = gen;
		try {
			const page = await api.listConversations({ folder: id, cursor });
			if (mine !== gen) return;
			upsert(page.conversations);
			folderLoaded.add(id);
			if (page.nextCursor) folderCursor.set(id, page.nextCursor);
			else folderCursor.delete(id);
			render();
		} catch {
			if (mine === gen) showToast(t("chatsLoadFailed"), "error");
		}
	}

	async function toggleFolder(id: string) {
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
		render({ focus: `folder:${id}` });
		if (expanded.has(id) && !folderLoaded.has(id)) await loadFolder(id);
	}

	// ── Chat actions ───────────────────────────────────────────────────────
	function openChat(id: string, leafId?: string) {
		drawer.closeIfDrawer();
		try {
			const opening = leafId === undefined ? chat.openConversation(id) : chat.openConversation(id, leafId);
			// A rejection shows nothing new: the chat toasts its own failure.
			void Promise.resolve(opening).catch(() => {});
		} catch {
			// Same for a synchronous throw.
		}
	}

	function failed() {
		showToast(t("chatActionFailed"), "error");
	}

	async function update(id: string, patch: ConversationUpdate, focus = `more:${id}`) {
		const before = conversations.get(id);
		if (!before) return;
		conversations.set(id, { ...before, ...patch } as ConversationSummary);
		render({ focus });
		try {
			const fresh = await api.patchConversation(id, patch);
			if (conversations.has(id)) conversations.set(id, fresh);
		} catch {
			if (conversations.has(id)) conversations.set(id, before);
			failed();
		}
		render();
	}

	/** Where focus goes when an item leaves the list: the next one, else the previous. */
	function neighbourKey(id: string): string | undefined {
		const links = [...sections.querySelectorAll<HTMLElement>(".sidebar-item .sidebar-link")];
		const at = links.findIndex((l) => l.dataset.focusKey === `link:${id}`);
		const next = links[at + 1] ?? links[at - 1];
		return next?.dataset.focusKey ?? undefined;
	}

	async function remove(id: string) {
		const before = conversations.get(id);
		if (!before) return;
		const focusKey = neighbourKey(id);
		conversations.delete(id);
		render({ focus: focusKey ?? "new-chat" });
		try {
			await api.deleteConversation(id);
		} catch {
			conversations.set(id, before);
			render();
			failed();
			return;
		}
		if (chat.currentConversationId() === id) chat.newChat();
		if (deleted) {
			deleted = [{ ...before, deletedAt: Date.now() }, ...deleted.filter((c) => c.id !== id)];
			render();
		}
		const mine = gen;
		showToast(t("chatDeleted"), "info", UNDO_TOAST_MS, {
			action: { label: t("chatUndo"), onClick: () => void restore(id, mine) },
		});
	}

	async function restore(id: string, mine: number) {
		try {
			const fresh = await api.restoreConversation(id);
			if (mine !== gen || mode !== "saved") return;
			dropDeleted(id);
			conversations.set(fresh.id, fresh);
			render();
			showToast(t("chatRestored"), "success");
		} catch {
			failed();
		}
	}

	function chatMenu(id: string): MenuItem[] {
		const c = conversations.get(id);
		if (!c) return [];
		const items: MenuItem[] = [
			{ label: t("chatRename"), onSelect: () => startRename({ kind: "chat", id }) },
			{ label: t(c.pinned ? "chatUnpin" : "chatPin"), onSelect: () => void update(id, { pinned: !c.pinned }) },
		];
		if (folders.length) {
			items.push({
				label: t("chatMove"),
				submenu: () => [
					{ label: t("chatMoveNone"), checked: !c.folderId, onSelect: () => void move(id, null) },
					...folders.map((f) => ({ label: f.name, checked: c.folderId === f.id, onSelect: () => void move(id, f.id) })),
				],
			});
		}
		items.push({ label: t("chatDelete"), onSelect: () => void remove(id) });
		return items;
	}

	async function move(id: string, folderId: string | null) {
		if (conversations.get(id)?.folderId === folderId) return;
		await update(id, { folderId });
	}

	// ── Inline fields (rename a chat or folder, name a new folder) ─────────
	function inlineInput(value: string, label: string, done: (value: string | null) => void): HTMLInputElement {
		const input = el("input", "sidebar-rename");
		input.type = "text";
		input.value = value;
		input.maxLength = 200;
		input.setAttribute("aria-label", label);
		let finished = false;
		const finish = (save: boolean) => {
			if (finished) return;
			finished = true;
			done(save ? cleanTitle(input.value) : null);
		};
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				finish(true);
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				finish(false);
			}
		});
		input.addEventListener("blur", () => finish(true));
		return input;
	}

	function startRename(target: { kind: "chat" | "folder"; id: string }) {
		const isChat = target.kind === "chat";
		const current = isChat ? conversations.get(target.id)?.title : folders.find((f) => f.id === target.id)?.name;
		if (current === undefined) return;
		const host = panel.querySelector<HTMLElement>(
			isChat ? `.sidebar-item[data-id="${cssEscape(target.id)}"]` : `.sidebar-folder[data-folder-id="${cssEscape(target.id)}"]`,
		);
		const link = host?.querySelector<HTMLElement>(":scope > .sidebar-row > .sidebar-link");
		if (!host || !link) return;
		editing = target;
		const focusKey = `${isChat ? "link" : "folder"}:${target.id}`;
		const input = inlineInput(current, t(isChat ? "chatRenameLabel" : "folderNameLabel"), (value) => {
			editing = null;
			render({ focus: focusKey, force: true });
			if (!value || value === current) return;
			if (isChat) void update(target.id, { title: value }, focusKey);
			else void renameFolder(target.id, value, focusKey);
		});
		link.replaceWith(input);
		input.focus();
		input.select();
	}

	function newFolderRow(): HTMLLIElement {
		const li = el("li", "sidebar-folder is-new");
		const input = inlineInput("", t("folderNameLabel"), (value) => {
			editing = null;
			render({ focus: "new-folder", force: true });
			if (value) void addFolder(value);
		});
		li.append(input);
		queueMicrotask(() => input.focus());
		return li;
	}

	// ── Folder actions ─────────────────────────────────────────────────────
	async function addFolder(name: string) {
		const mine = gen;
		try {
			const folder = await api.createFolder(name);
			if (mine !== gen) return;
			folders = sortFolders([...folders, folder]);
			folderLoaded.add(folder.id);
			render({ focus: `folder:${folder.id}` });
		} catch {
			failed();
		}
	}

	async function renameFolder(id: string, name: string, focus?: string) {
		const before = folders.find((f) => f.id === id);
		if (!before) return;
		folders = folders.map((f) => (f.id === id ? { ...f, name } : f));
		render({ focus });
		try {
			const fresh = await api.patchFolder(id, { name });
			folders = folders.map((f) => (f.id === id ? fresh : f));
		} catch {
			folders = folders.map((f) => (f.id === id ? before : f));
			failed();
		}
		render();
	}

	async function removeFolder(id: string) {
		const before = folders;
		const moved = [...conversations.values()].filter((c) => c.folderId === id);
		confirmingFolder = null;
		folders = folders.filter((f) => f.id !== id);
		for (const c of moved) conversations.set(c.id, { ...c, folderId: null });
		render({ focus: "new-folder" });
		try {
			await api.deleteFolder(id);
			expanded.delete(id);
			folderLoaded.delete(id);
			folderCursor.delete(id);
		} catch {
			folders = before;
			for (const c of moved) if (conversations.has(c.id)) conversations.set(c.id, c);
			failed();
			render();
		}
	}

	function folderMenu(id: string): MenuItem[] {
		return [
			{ label: t("folderRename"), onSelect: () => startRename({ kind: "folder", id }) },
			{
				label: t("folderDelete"),
				onSelect: () => {
					confirmingFolder = id;
					render({ focus: `confirm-no:${id}`, force: true });
				},
			},
		];
	}

	// ── Wiring ─────────────────────────────────────────────────────────────
	newChatButton.addEventListener("click", () => {
		chat.newChat();
		drawer.closeIfDrawer();
		document.getElementById("user-input")?.focus();
	});
	offOpen.addEventListener("click", () => {
		drawer.closeIfDrawer();
		options.openPrivacy();
	});
	moreButton.addEventListener("click", () => void loadMore());
	deletedToggle.addEventListener("click", toggleDeleted);
	newFolderButton.addEventListener("click", () => {
		if (editing) return;
		closeMenu();
		editing = { kind: "new-folder" };
		render({ force: true });
	});

	// One signal removes every page-level listener (destroy, for tests).
	const listening = new AbortController();
	const on = { signal: listening.signal };
	window.addEventListener(CONVERSATION_UPDATED_EVENT, (event) => {
		const conversation = (event as CustomEvent<ConversationUpdatedDetail>).detail?.conversation;
		if (mode !== "saved" || !conversation) return;
		conversations.set(conversation.id, conversation);
		render();
	}, on);
	window.addEventListener(CONVERSATION_CHANGED_EVENT, (event) => {
		activeId = (event as CustomEvent<ConversationChangedDetail>).detail?.conversationId ?? null;
		markActive();
	}, on);
	window.addEventListener(HISTORY_DELETED_EVENT, () => {
		if (mode !== "saved") return;
		reset();
		void load();
	}, on);
	document.addEventListener("eleen:turn-complete", () => {
		if (mode !== "saved") return;
		clearTimeout(turnTimer);
		turnTimer = setTimeout(() => void refresh(), turnRefreshMs);
	}, on);

	function reset() {
		gen++;
		clearTimeout(turnTimer);
		closeMenu();
		search.clear();
		conversations = new Map();
		folders = [];
		nextCursor = null;
		loadingMore = false;
		status = "idle";
		expanded.clear();
		folderLoaded.clear();
		folderCursor.clear();
		confirmingFolder = null;
		editing = null;
		dirty = false;
		deletedOpen = false;
		deleted = null;
		deletedCursor = null;
		deletedStatus = "idle";
		confirmingPurge = null;
		deletedBody.replaceChildren();
		pinned.list.replaceChildren();
		foldersSection.list.replaceChildren();
		recent.list.replaceChildren();
		state.replaceChildren();
	}

	function setMode(next: SidebarMode) {
		if (next === mode) return;
		mode = next;
		reset();
		activeId = chat.currentConversationId();
		applyMode();
		drawer.setAvailable(mode !== "hidden");
		if (mode === "saved") void load();
	}

	applyMode();
	return {
		setMode,
		mode: () => mode,
		drawer,
		panel,
		destroy() {
			setMode("hidden");
			listening.abort();
		},
	};
}
