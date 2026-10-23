import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary, DeletedConversation, Folder } from "../../../src/shared/history";
import { CONVERSATION_CHANGED_EVENT, CONVERSATION_UPDATED_EVENT } from "../history/state";
import { sidebarMode } from "./index";
import { createSidebar, HISTORY_DELETED_EVENT, type Sidebar, type SidebarApi } from "./sidebar";

const conv = (id: string, updatedAt: number, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id,
	title: `Chat ${id}`,
	pinned: false,
	folderId: null,
	createdAt: 1,
	updatedAt,
	...extra,
});

let current: Sidebar | null = null;

afterEach(() => {
	current?.destroy();
	current = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	delete document.documentElement.dataset.sidebar;
	try {
		localStorage.clear();
	} catch {
		// ignore
	}
});

function fakeApi(list: ConversationSummary[], folders: Folder[] = []) {
	const api = {
		listConversations: vi.fn(async (options?: { folder?: string }) => ({
			conversations: options?.folder ? list.filter((c) => c.folderId === options.folder) : list,
			nextCursor: null,
		})),
		listFolders: vi.fn(async () => folders),
		patchConversation: vi.fn(async (id: string, update: Partial<ConversationSummary>) => ({
			...(list.find((c) => c.id === id) as ConversationSummary),
			...update,
		})),
		deleteConversation: vi.fn(async () => {}),
		restoreConversation: vi.fn(async (id: string) => list.find((c) => c.id === id) as ConversationSummary),
		listDeletedConversations: vi.fn(async (_options?: { cursor?: string | null }) => ({
			conversations: [] as DeletedConversation[],
			nextCursor: null as string | null,
		})),
		purgeConversation: vi.fn(async (_id: string) => {}),
		createFolder: vi.fn(async (name: string) => ({ id: `f-${name}`, name, position: 9 })),
		patchFolder: vi.fn(async (id: string, update: { name?: string }) => ({ id, name: update.name ?? "", position: 0 })),
		deleteFolder: vi.fn(async () => {}),
		search: vi.fn(async () => []),
	} satisfies SidebarApi;
	return api;
}

function setup(api: SidebarApi, { open = "c1" as string | null } = {}) {
	const chat = {
		newChat: vi.fn(),
		openConversation: vi.fn(async () => {}),
		currentConversationId: vi.fn(() => open),
	};
	const openPrivacy = vi.fn();
	const sidebar = createSidebar({ chat, openPrivacy, api });
	current = sidebar;
	const root = sidebar.panel;
	const titles = (selector: string) =>
		[...root.querySelectorAll<HTMLElement>(`${selector} .sidebar-item .sidebar-title`)].map((t) => t.textContent);
	const item = (id: string) => root.querySelector<HTMLElement>(`.sidebar-item[data-id="${id}"]`);
	const menuItem = (label: string) =>
		[...document.querySelectorAll<HTMLButtonElement>(".sidebar-menu-item")].find((b) => b.textContent === label);
	const openMenu = (id: string) => item(id)?.querySelector<HTMLButtonElement>(".sidebar-more")?.click();
	return { sidebar, chat, openPrivacy, root, titles, item, menuItem, openMenu };
}

describe("sidebarMode", () => {
	it("hides for guests and while consent loads, then follows history", () => {
		const base = { conversationId: null, messages: [], activeLeafId: null };
		expect(sidebarMode({ ...base, signedIn: false, historyOn: true })).toBe("hidden");
		expect(sidebarMode({ ...base, signedIn: true, historyOn: null })).toBe("hidden");
		expect(sidebarMode({ ...base, signedIn: true, historyOn: false })).toBe("off");
		expect(sidebarMode({ ...base, signedIn: true, historyOn: true })).toBe("saved");
	});
});

describe("sidebar visibility", () => {
	it("shows nothing when hidden, and only New chat and the hint with history off", async () => {
		const api = fakeApi([conv("c1", 1)]);
		const ui = setup(api);
		const toggle = document.getElementById("sidebar-toggle") as HTMLButtonElement;
		expect(ui.root.hidden).toBe(true);
		expect(toggle.hidden).toBe(true);
		expect(document.documentElement.dataset.sidebar).toBeUndefined();

		ui.sidebar.setMode("off");
		expect(ui.root.hidden).toBe(false);
		expect(toggle.hidden).toBe(false);
		expect(ui.root.querySelector<HTMLElement>(".sidebar-head")?.hidden).toBe(true);
		expect(ui.root.querySelector<HTMLElement>(".sidebar-sections")?.hidden).toBe(true);
		expect(ui.root.querySelector(".sidebar-hint")?.textContent).toContain("Chats are not being saved");
		expect(api.listConversations).not.toHaveBeenCalled();
		[...ui.root.querySelectorAll("button")].find((b) => b.textContent === "Open Memory and privacy")?.click();
		expect(ui.openPrivacy).toHaveBeenCalledOnce();

		ui.sidebar.setMode("hidden");
		expect(ui.root.hidden).toBe(true);
		expect(toggle.hidden).toBe(true);
	});

	it("opens pinned on desktop by default and remembers a collapse", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {} }));
		const ui = setup(fakeApi([]));
		ui.sidebar.setMode("off");
		const toggle = document.getElementById("sidebar-toggle") as HTMLButtonElement;
		expect(document.documentElement.dataset.sidebar).toBe("open");
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(toggle.textContent).toBe("Close conversations");
		toggle.click();
		expect(document.documentElement.dataset.sidebar).toBe("closed");
		expect(ui.root.inert).toBe(true);
		expect(localStorage.getItem("eleen.sidebar")).toBe("collapsed");
	});

	it("is a closed drawer on a phone; Escape closes it and focus returns to the toggle", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {} }));
		const ui = setup(fakeApi([]));
		ui.sidebar.setMode("saved");
		const toggle = document.getElementById("sidebar-toggle") as HTMLButtonElement;
		const scrim = document.getElementById("sidebar-scrim") as HTMLElement;
		expect(ui.sidebar.drawer.isOpen()).toBe(false);
		expect(scrim.hidden).toBe(true);
		toggle.click();
		expect(ui.sidebar.drawer.isOpen()).toBe(true);
		expect(scrim.hidden).toBe(false);
		expect(document.activeElement?.id).toBe("sidebar-search-input");
		ui.root.querySelector(".sidebar-new")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(ui.sidebar.drawer.isOpen()).toBe(false);
		expect(document.activeElement).toBe(toggle);
	});
});

describe("sidebar list", () => {
	it("groups into Pinned, Folders and Recent, as text, with the open chat marked", async () => {
		const api = fakeApi(
			[
				conv("c1", 3),
				conv("c2", 5, { pinned: true }),
				conv("c3", 4, { folderId: "f1" }),
				conv("c4", 2, { title: '<img src=x onerror="window.__xss=1">' }),
				conv("c5", 1, { title: "  " }),
			],
			[{ id: "f1", name: "Work", position: 0 }],
		);
		const ui = setup(api);
		ui.sidebar.setMode("saved");
		await vi.waitFor(() => expect(ui.titles(".is-recent")).toHaveLength(3));
		expect(ui.titles(".is-pinned")).toEqual(["Chat c2"]);
		expect(ui.titles(".is-recent")).toEqual(["Chat c1", '<img src=x onerror="window.__xss=1">', "New conversation"]);
		expect(ui.root.querySelector("img")).toBeNull();
		expect(ui.item("c1")?.querySelector(".sidebar-link")?.getAttribute("aria-current")).toBe("page");

		// The folder loads its own page on first expand.
		const folder = ui.root.querySelector<HTMLButtonElement>(".sidebar-folder-toggle");
		expect(folder?.getAttribute("aria-label")).toBe("Show Work");
		folder?.click();
		await vi.waitFor(() => expect(ui.titles(".sidebar-folder")).toEqual(["Chat c3"]));
		expect(api.listConversations).toHaveBeenCalledWith({ folder: "f1", cursor: undefined });
		expect(ui.root.querySelector(".sidebar-folder-toggle")?.getAttribute("aria-expanded")).toBe("true");

		window.dispatchEvent(new CustomEvent(CONVERSATION_CHANGED_EVENT, { detail: { conversationId: "c2" } }));
		expect(ui.item("c2")?.classList.contains("is-active")).toBe(true);
		expect(ui.item("c1")?.querySelector("[aria-current]")).toBeNull();

		window.dispatchEvent(new CustomEvent(CONVERSATION_UPDATED_EVENT, { detail: { conversation: conv("c9", 9, { title: "Fresh" }) } }));
		expect(ui.titles(".is-recent")[0]).toBe("Fresh");

		ui.item("c1")?.querySelector<HTMLButtonElement>(".sidebar-link")?.click();
		expect(ui.chat.openConversation).toHaveBeenCalledWith("c1");
	});

	it("shows the empty state, and an error with a working retry", async () => {
		const api = fakeApi([]);
		api.listConversations.mockRejectedValueOnce(new Error("down"));
		const ui = setup(api);
		ui.sidebar.setMode("saved");
		await vi.waitFor(() => expect(ui.root.querySelector(".sidebar-state.is-error")?.textContent).toContain("Could not load your chats."));
		[...ui.root.querySelectorAll("button")].find((b) => b.textContent === "Try again")?.click();
		await vi.waitFor(() => expect(ui.root.querySelector(".sidebar-state.is-empty")?.textContent).toBe("Your saved chats will appear here."));
	});

	it("clears on HISTORY_DELETED_EVENT and on leaving saved mode", async () => {
		const list = [conv("c1", 1)];
		const api = fakeApi(list);
		const ui = setup(api);
		ui.sidebar.setMode("saved");
		await vi.waitFor(() => expect(ui.item("c1")).not.toBeNull());
		list.length = 0;
		window.dispatchEvent(new CustomEvent(HISTORY_DELETED_EVENT));
		expect(ui.item("c1")).toBeNull();
		await vi.waitFor(() => expect(ui.root.querySelector(".sidebar-state.is-empty")).not.toBeNull());

		list.push(conv("c2", 1));
		window.dispatchEvent(new CustomEvent(HISTORY_DELETED_EVENT));
		await vi.waitFor(() => expect(ui.item("c2")).not.toBeNull());
		ui.sidebar.setMode("hidden");
		expect(ui.item("c2")).toBeNull();
	});
});

describe("item menu", () => {
	async function ready(list: ConversationSummary[], folders: Folder[] = []) {
		const api = fakeApi(list, folders);
		const ui = setup(api);
		ui.sidebar.setMode("saved");
		await vi.waitFor(() => expect(ui.item(list[0]?.id ?? "")).not.toBeNull());
		return { api, ui };
	}

	it("opens from the options button with a keyboard-driven menu", async () => {
		const { ui } = await ready([conv("c1", 1)]);
		const more = ui.item("c1")?.querySelector<HTMLButtonElement>(".sidebar-more");
		expect(more?.getAttribute("aria-label")).toBe("Options for Chat c1");
		expect(more?.getAttribute("aria-haspopup")).toBe("menu");
		more?.click();
		expect(more?.getAttribute("aria-expanded")).toBe("true");
		const menu = document.querySelector<HTMLElement>("[role='menu']");
		expect(document.activeElement?.textContent).toBe("Rename");
		menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement?.textContent).toBe("Pin");
		menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
		menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
		expect(document.activeElement?.textContent).toBe("Delete");
		menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.querySelector("[role='menu']")).toBeNull();
		expect(document.activeElement).toBe(more);
		expect(more?.getAttribute("aria-expanded")).toBe("false");
	});

	it("pins with PATCH, and puts it back with a toast when that fails", async () => {
		const { api, ui } = await ready([conv("c1", 2), conv("c2", 1)]);
		ui.openMenu("c2");
		ui.menuItem("Pin")?.click();
		expect(ui.titles(".is-pinned")).toEqual(["Chat c2"]);
		await vi.waitFor(() => expect(api.patchConversation).toHaveBeenCalledWith("c2", { pinned: true }));

		api.patchConversation.mockRejectedValueOnce(new Error("down"));
		ui.openMenu("c1");
		ui.menuItem("Pin")?.click();
		expect(ui.titles(".is-pinned")).toContain("Chat c1");
		await vi.waitFor(() => expect(ui.titles(".is-pinned")).toEqual(["Chat c2"]));
		expect(document.querySelector(".toast.error")?.textContent).toContain("Could not update that chat.");
	});

	it("renames inline: Enter saves the trimmed title, Escape cancels", async () => {
		const { api, ui } = await ready([conv("c1", 1)]);
		ui.openMenu("c1");
		ui.menuItem("Rename")?.click();
		let input = ui.item("c1")?.querySelector<HTMLInputElement>(".sidebar-rename");
		expect(input?.getAttribute("aria-label")).toBe("Name for this chat");
		expect(document.activeElement).toBe(input);
		input!.value = "  Trip plan  ";
		input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(ui.titles(".is-recent")).toEqual(["Trip plan"]);
		await vi.waitFor(() => expect(api.patchConversation).toHaveBeenCalledWith("c1", { title: "Trip plan" }));

		ui.openMenu("c1");
		ui.menuItem("Rename")?.click();
		input = ui.item("c1")?.querySelector<HTMLInputElement>(".sidebar-rename");
		input!.value = "Nope";
		input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(ui.titles(".is-recent")).toEqual(["Trip plan"]);
		expect(api.patchConversation).toHaveBeenCalledTimes(1);
	});

	it("moves to a folder from the submenu", async () => {
		const { api, ui } = await ready([conv("c1", 1)], [{ id: "f1", name: "Work", position: 0 }]);
		ui.openMenu("c1");
		ui.menuItem("Move to folder")?.click();
		expect(ui.menuItem("No folder")?.getAttribute("aria-checked")).toBe("true");
		ui.menuItem("Work")?.click();
		await vi.waitFor(() => expect(api.patchConversation).toHaveBeenCalledWith("c1", { folderId: "f1" }));
		expect(ui.titles(".is-recent")).toEqual([]);
	});

	it("deletes at once, offers Undo, and Undo restores it", async () => {
		const { api, ui } = await ready([conv("c1", 2), conv("c2", 1)]);
		ui.openMenu("c1");
		ui.menuItem("Delete")?.click();
		expect(ui.item("c1")).toBeNull();
		await vi.waitFor(() => expect(document.querySelector(".toast")?.textContent).toContain("Chat deleted."));
		expect(api.deleteConversation).toHaveBeenCalledWith("c1");
		// It was the open chat, so a new one starts.
		expect(ui.chat.newChat).toHaveBeenCalledOnce();

		document.querySelector<HTMLButtonElement>(".toast-action")?.click();
		await vi.waitFor(() => expect(ui.item("c1")).not.toBeNull());
		expect(api.restoreConversation).toHaveBeenCalledWith("c1");
		expect(document.querySelector(".toast.success")?.textContent).toContain("Chat restored.");
	});

	describe("Recently deleted", () => {
		const deletedToggle = (root: HTMLElement) => root.querySelector<HTMLButtonElement>(".sidebar-deleted-toggle")!;
		const deletedTitles = (root: HTMLElement) =>
			[...root.querySelectorAll(".sidebar-deleted-item .sidebar-title")].map((n) => n.textContent);
		const buttonIn = (root: HTMLElement, label: string) =>
			[...root.querySelectorAll<HTMLButtonElement>(".sidebar-deleted-body button")].find((b) => b.textContent === label);

		it("is collapsed and loads on first expand only", async () => {
			const { api, ui } = await ready([conv("c1", 1)]);
			api.listDeletedConversations.mockResolvedValueOnce({
				conversations: [{ ...conv("d1", 1, { title: '<img src=x onerror="alert(1)">' }), deletedAt: 5 }],
				nextCursor: null,
			});
			const toggle = deletedToggle(ui.root);
			expect(toggle.getAttribute("aria-expanded")).toBe("false");
			expect(api.listDeletedConversations).not.toHaveBeenCalled();
			toggle.click();
			await vi.waitFor(() => expect(deletedTitles(ui.root)).toEqual(['<img src=x onerror="alert(1)">']));
			// Text, never markup.
			expect(ui.root.querySelector(".sidebar-deleted-body img")).toBeNull();
			expect(ui.root.querySelector(".sidebar-deleted-body .sidebar-hint")?.textContent).toContain("30 days");
			deletedToggle(ui.root).click();
			deletedToggle(ui.root).click();
			expect(api.listDeletedConversations).toHaveBeenCalledOnce();
		});

		it("restores a chat into the list", async () => {
			const { api, ui } = await ready([conv("c1", 2), conv("d1", 1)]);
			api.listDeletedConversations.mockResolvedValueOnce({ conversations: [{ ...conv("d1", 1), deletedAt: 5 }], nextCursor: null });
			// d1 is in the list only so the fake restore can return it; take it out first.
			ui.openMenu("d1");
			ui.menuItem("Delete")?.click();
			await vi.waitFor(() => expect(api.deleteConversation).toHaveBeenCalledWith("d1"));
			deletedToggle(ui.root).click();
			await vi.waitFor(() => expect(deletedTitles(ui.root)).toEqual(["Chat d1"]));
			buttonIn(ui.root, "Restore")?.click();
			await vi.waitFor(() => expect(ui.item("d1")).not.toBeNull());
			expect(api.restoreConversation).toHaveBeenCalledWith("d1");
			expect(deletedTitles(ui.root)).toEqual([]);
		});

		it("shows a chat deleted after it was opened, and deletes forever behind a confirm", async () => {
			const { api, ui } = await ready([conv("c1", 2), conv("c2", 1)]);
			deletedToggle(ui.root).click();
			await vi.waitFor(() => expect(ui.root.querySelector(".sidebar-deleted-body .is-empty")).not.toBeNull());
			ui.openMenu("c2");
			ui.menuItem("Delete")?.click();
			await vi.waitFor(() => expect(deletedTitles(ui.root)).toEqual(["Chat c2"]));

			buttonIn(ui.root, "Delete forever")?.click();
			expect(api.purgeConversation).not.toHaveBeenCalled();
			expect(ui.root.querySelector(".sidebar-deleted-body .sidebar-confirm")?.textContent).toContain('Delete "Chat c2" for good?');
			const confirmYes = [...ui.root.querySelectorAll<HTMLButtonElement>(".sidebar-deleted-body .sidebar-confirm button")].find(
				(b) => b.textContent === "Delete forever",
			);
			confirmYes?.click();
			await vi.waitFor(() => expect(api.purgeConversation).toHaveBeenCalledWith("c2"));
			expect(deletedTitles(ui.root)).toEqual([]);
		});

		it("puts a row back when delete forever fails", async () => {
			const { api, ui } = await ready([conv("c1", 1)]);
			api.listDeletedConversations.mockResolvedValueOnce({ conversations: [{ ...conv("d1", 1), deletedAt: 5 }], nextCursor: null });
			api.purgeConversation.mockRejectedValueOnce(new Error("down"));
			deletedToggle(ui.root).click();
			await vi.waitFor(() => expect(deletedTitles(ui.root)).toEqual(["Chat d1"]));
			buttonIn(ui.root, "Delete forever")?.click();
			[...ui.root.querySelectorAll<HTMLButtonElement>(".sidebar-confirm button")].find((b) => b.textContent === "Delete forever")?.click();
			await vi.waitFor(() => expect(document.querySelector(".toast.error")).not.toBeNull());
			expect(deletedTitles(ui.root)).toEqual(["Chat d1"]);
		});
	});

	it("puts a chat back when the delete fails", async () => {
		const { api, ui } = await ready([conv("c1", 2), conv("c2", 1)]);
		api.deleteConversation.mockRejectedValueOnce(new Error("down"));
		ui.openMenu("c2");
		ui.menuItem("Delete")?.click();
		expect(ui.item("c2")).toBeNull();
		await vi.waitFor(() => expect(ui.item("c2")).not.toBeNull());
		expect(ui.chat.newChat).not.toHaveBeenCalled();
		expect(document.querySelector(".toast.error")).not.toBeNull();
	});
});

describe("folders", () => {
	it("creates a folder from an inline name field", async () => {
		const api = fakeApi([conv("c1", 1)]);
		const ui = setup(api);
		ui.sidebar.setMode("saved");
		await vi.waitFor(() => expect(ui.item("c1")).not.toBeNull());
		ui.root.querySelector<HTMLButtonElement>(".sidebar-new-folder")?.click();
		await Promise.resolve();
		const input = ui.root.querySelector<HTMLInputElement>(".sidebar-folder.is-new .sidebar-rename");
		expect(input?.getAttribute("aria-label")).toBe("Folder name");
		input!.value = "Ideas";
		input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(ui.root.querySelector(".sidebar-folder .sidebar-title")?.textContent).toBe("Ideas"));
		expect(api.createFolder).toHaveBeenCalledWith("Ideas");
	});

	it("deletes a folder after an inline confirm; its chats move to Recent", async () => {
		const api = fakeApi([conv("c1", 1, { folderId: "f1" })], [{ id: "f1", name: "Work", position: 0 }]);
		const ui = setup(api);
		ui.sidebar.setMode("saved");
		await vi.waitFor(() => expect(ui.root.querySelector(".sidebar-folder")).not.toBeNull());
		expect(ui.titles(".is-recent")).toEqual([]);
		ui.root.querySelector<HTMLButtonElement>(".sidebar-folder .sidebar-more")?.click();
		ui.menuItem("Delete folder")?.click();
		const confirm = ui.root.querySelector(".sidebar-confirm");
		expect(confirm?.textContent).toContain('Delete "Work"? Its chats move back to Recent.');
		expect(document.activeElement?.textContent).toBe("Cancel");
		[...confirm!.querySelectorAll("button")].find((b) => b.textContent === "Delete folder")?.click();
		expect(ui.root.querySelector(".sidebar-folder")).toBeNull();
		expect(ui.titles(".is-recent")).toEqual(["Chat c1"]);
		await vi.waitFor(() => expect(api.deleteFolder).toHaveBeenCalledWith("f1"));
	});
});
