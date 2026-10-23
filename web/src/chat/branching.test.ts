import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "../../../src/shared/history";
import { createAssistantMessage, createBranchNav, createUserTurn, setBranchNav, setTurnId } from "./render";
import { openEditor } from "./edit";

const api = vi.hoisted(() => ({
	getConversation: vi.fn(),
	patchConversation: vi.fn(),
}));
vi.mock("../history/api", () => api);

const { createChat } = await import("./controller");
const { resetHistoryState, getHistoryState, setHistoryState } = await import("../history/state");

function message(partial: Partial<StoredMessage> & Pick<StoredMessage, "id" | "seq" | "role">): StoredMessage {
	return {
		parentId: null,
		content: "",
		reasoning: null,
		model: null,
		status: "complete",
		compareGroup: null,
		completionTokens: null,
		createdAt: 1,
		...partial,
	};
}

describe("branch navigator", () => {
	it("labels its buttons and says the position in words", () => {
		const nav = createBranchNav({ index: 2, count: 3, prevId: "a", nextId: "c" });
		const [prev, next] = [...nav.querySelectorAll<HTMLButtonElement>(".branch-button")];
		expect(prev?.getAttribute("aria-label")).toBe("Previous version");
		expect(next?.getAttribute("aria-label")).toBe("Next version");
		expect(prev?.dataset.branch).toBe("a");
		expect(next?.dataset.branch).toBe("c");
		expect(nav.querySelector(".branch-count")?.textContent).toBe("2/3");
		expect(nav.querySelector(".branch-count")?.getAttribute("aria-hidden")).toBe("true");
		expect(nav.querySelector(".sr-only")?.textContent).toBe("Version 2 of 3");
		// The carets point along the reading direction, so they mirror in RTL.
		expect(prev?.querySelector("svg")?.hasAttribute("data-mirror")).toBe(true);
	});

	it("disables the end it cannot go past", () => {
		const nav = createBranchNav({ index: 1, count: 2, prevId: null, nextId: "b" });
		const [prev, next] = [...nav.querySelectorAll<HTMLButtonElement>(".branch-button")];
		expect(prev?.disabled).toBe(true);
		expect(next?.disabled).toBe(false);
	});

	it("goes in a user turn's row, a reply's action row, or a row added under an error", () => {
		const user = createUserTurn("hi", "u1");
		setBranchNav(user, { index: 1, count: 2, prevId: null, nextId: "u2" });
		expect(user.querySelector(".turn-actions > .branch-nav")).not.toBeNull();
		setBranchNav(user, { index: 1, count: 1, prevId: null, nextId: null });
		expect(user.querySelector(".branch-nav")).toBeNull();

		const reply = createAssistantMessage();
		reply.finish("hello");
		setBranchNav(reply.root, { index: 2, count: 2, prevId: "a1", nextId: null });
		expect(reply.root.querySelector(".message-actions > .branch-nav:first-child")).not.toBeNull();

		const failed = createAssistantMessage();
		failed.fail("nope");
		setBranchNav(failed.root, { index: 1, count: 2, prevId: null, nextId: "a2" });
		expect(failed.root.querySelector(".message-body > .message-actions > .branch-nav")).not.toBeNull();
	});

	it("gives a user turn Edit only once it has an id", () => {
		const turn = createUserTurn("hi");
		expect(turn.querySelector(".edit-button")).toBeNull();
		setTurnId(turn, "u1");
		expect(turn.dataset.messageId).toBe("u1");
		const edit = turn.querySelector<HTMLButtonElement>(".edit-button");
		expect(edit?.dataset.action).toBe("edit");
		expect(edit?.textContent).toBe("Edit message");
		setTurnId(turn, "u1");
		expect(turn.querySelectorAll(".edit-button")).toHaveLength(1);
	});
});

describe("inline editor", () => {
	const key = (target: Element, init: KeyboardEventInit) =>
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

	it("replaces the bubble with a textarea and Cancel puts it back", () => {
		const turn = createUserTurn("original", "u1");
		document.body.append(turn);
		const onSave = vi.fn();
		const textarea = openEditor(turn, "original", { onSave });
		expect(textarea.value).toBe("original");
		expect(document.activeElement).toBe(textarea);
		expect(turn.querySelector<HTMLElement>(".user-message")?.hidden).toBe(true);
		expect(turn.querySelector(".edit-save")?.textContent).toBe("Save and send");

		turn.querySelector<HTMLButtonElement>(".edit-cancel")?.click();
		expect(turn.querySelector(".turn-editor")).toBeNull();
		expect(turn.querySelector<HTMLElement>(".user-message")?.hidden).toBe(false);
		expect(onSave).not.toHaveBeenCalled();
		turn.remove();
	});

	it("cancels on Escape and saves the trimmed text on Ctrl+Enter", () => {
		const turn = createUserTurn("original", "u1");
		const onSave = vi.fn();
		let textarea = openEditor(turn, "original", { onSave });
		key(textarea, { key: "Escape" });
		expect(turn.querySelector(".turn-editor")).toBeNull();

		textarea = openEditor(turn, "original", { onSave });
		textarea.value = "  changed  ";
		textarea.dispatchEvent(new Event("input"));
		key(textarea, { key: "Enter", ctrlKey: true });
		expect(onSave).toHaveBeenCalledWith("changed");
		expect(turn.querySelector(".turn-editor")).toBeNull();
	});

	it("will not save an empty message", () => {
		const turn = createUserTurn("original", "u1");
		const onSave = vi.fn();
		const textarea = openEditor(turn, "original", { onSave });
		textarea.value = "   ";
		textarea.dispatchEvent(new Event("input"));
		expect(turn.querySelector<HTMLButtonElement>(".edit-save")?.disabled).toBe(true);
		key(textarea, { key: "Enter", metaKey: true });
		expect(onSave).not.toHaveBeenCalled();
	});
});

describe("opening a saved conversation", () => {
	// u1 -> a1 (stopped) | a2 (error), and u1 -> a2 is the stored active leaf.
	const tree: StoredMessage[] = [
		message({ id: "u1", seq: 1, role: "user", content: "Tell me a story" }),
		message({ id: "a1", seq: 2, role: "assistant", parentId: "u1", content: "Once upon", status: "stopped" }),
		message({ id: "a2", seq: 3, role: "assistant", parentId: "u1", content: "", status: "error" }),
	];
	let container: HTMLElement;

	beforeEach(() => {
		resetHistoryState();
		setHistoryState({ signedIn: true, historyOn: true });
		container = document.createElement("div");
		document.body.append(container);
		api.getConversation.mockReset();
		api.patchConversation.mockReset();
		api.patchConversation.mockResolvedValue({});
	});

	afterEach(() => {
		container.remove();
		vi.useRealTimers();
	});

	function chat() {
		return createChat({ messages: container, onBusyChange: () => {}, emptyState: () => document.createElement("div") });
	}

	it("replays the active branch, with the error state and a navigator", async () => {
		api.getConversation.mockResolvedValue({
			conversation: { id: "c1", title: "Story", pinned: false, folderId: null, createdAt: 1, updatedAt: 1, activeLeafId: "a2" },
			messages: tree,
		});
		const c = chat();
		await c.openConversation("c1");

		expect(c.currentConversationId()).toBe("c1");
		expect(getHistoryState().activeLeafId).toBe("a2");
		const reply = container.querySelector<HTMLElement>('[data-message-id="a2"]');
		expect(reply?.querySelector(".message-error")).not.toBeNull();
		expect(reply?.querySelector(".branch-count")?.textContent).toBe("2/2");
		expect(container.querySelector('[data-message-id="u1"] .user-message')?.textContent).toBe("Tell me a story");
		expect(c.history().map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
	});

	it("switches to the stopped sibling, replays it as stopped, and saves the switch once", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		api.getConversation.mockResolvedValue({
			conversation: { id: "c1", title: "Story", pinned: false, folderId: null, createdAt: 1, updatedAt: 1, activeLeafId: "a2" },
			messages: tree,
		});
		const c = chat();
		await c.openConversation("c1");

		container.querySelector<HTMLButtonElement>('[data-message-id="a2"] .branch-button[aria-label="Previous version"]')?.click();
		const reply = container.querySelector<HTMLElement>('[data-message-id="a1"]');
		expect(reply?.querySelector(".message-note")?.textContent).toBe("Stopped. What was written so far is saved.");
		expect(reply?.textContent).toContain("Once upon");
		expect(reply?.querySelector(".branch-count")?.textContent).toBe("1/2");
		expect(api.patchConversation).not.toHaveBeenCalled();

		vi.advanceTimersByTime(400);
		expect(api.patchConversation).toHaveBeenCalledTimes(1);
		expect(api.patchConversation).toHaveBeenCalledWith("c1", { activeLeafId: "a1" });
	});

	it("opens on a search hit's branch and saves it as the active one", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		api.getConversation.mockResolvedValue({
			conversation: { id: "c1", title: "Story", pinned: false, folderId: null, createdAt: 1, updatedAt: 1, activeLeafId: "a2" },
			messages: tree,
		});
		const c = chat();
		await c.openConversation("c1", "a1");
		expect(getHistoryState().activeLeafId).toBe("a1");
		vi.advanceTimersByTime(400);
		expect(api.patchConversation).toHaveBeenCalledWith("c1", { activeLeafId: "a1" });
	});

	it("rejects and puts the page back when the conversation cannot be loaded", async () => {
		api.getConversation.mockRejectedValue(new Error("offline"));
		const c = chat();
		const before = document.createElement("p");
		before.textContent = "what was here";
		container.replaceChildren(before);
		await expect(c.openConversation("c1")).rejects.toThrow();
		expect(container.firstChild).toBe(before);
		expect(c.currentConversationId()).toBeNull();
	});

	it("a new chat after deleting all history leaves the saved one", async () => {
		api.getConversation.mockResolvedValue({
			conversation: { id: "c1", title: "Story", pinned: false, folderId: null, createdAt: 1, updatedAt: 1, activeLeafId: "a2" },
			messages: tree,
		});
		const c = chat();
		await c.openConversation("c1");
		window.dispatchEvent(new CustomEvent("eleen:history-deleted"));
		expect(c.currentConversationId()).toBeNull();
		expect(container.querySelector("[data-message-id]")).toBeNull();
	});
});
