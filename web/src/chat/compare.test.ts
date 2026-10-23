import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "../../../src/shared/history";
import type { StreamEvent } from "../../../src/shared/stream";
import { createCompareTurn } from "./compare";

const api = vi.hoisted(() => ({
	getConversation: vi.fn(),
	patchConversation: vi.fn(),
}));
vi.mock("../history/api", () => api);

// Signed in, and a chat stream the test scripts.
const stream = vi.hoisted(() => ({ events: [] as StreamEvent[], bodies: [] as unknown[] }));
vi.mock("../auth/clerk", () => ({ isSignedIn: () => true, openSignIn: vi.fn() }));
vi.mock("../api/client", async (original) => {
	const real = await original<typeof import("../api/client")>();
	return {
		...real,
		streamChat: async function* (body: unknown) {
			// As sent: the real client serialises the body at once.
			stream.bodies.push(structuredClone(body));
			for (const event of stream.events) yield event;
		},
	};
});

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

describe("compare turn view", () => {
	it("has a tab and a panel per model, one tab stop, and only the selected lane current", () => {
		const turn = createCompareTurn(["Llama 3.1 8B", "Llama 3.3 70B", "DeepSeek R1 32B"]);
		const tabs = [...turn.root.querySelectorAll<HTMLButtonElement>("[role='tab']")];
		const panels = [...turn.root.querySelectorAll<HTMLElement>("[role='tabpanel']")];
		expect(turn.root.getAttribute("aria-label")).toBe("Answers from 3 models");
		expect(turn.root.style.getPropertyValue("--lanes")).toBe("3");
		expect(tabs.map((t) => t.textContent)).toEqual(["Llama 3.1 8B", "Llama 3.3 70B", "DeepSeek R1 32B"]);
		expect(panels.map((p) => p.getAttribute("aria-labelledby"))).toEqual(tabs.map((t) => t.id));
		expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
		expect(panels.map((p) => p.classList.contains("is-current"))).toEqual([true, false, false]);

		tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
		expect(panels[1]!.classList.contains("is-current")).toBe(true);
		tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
		expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
		tabs[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
	});

	it("shows a skeleton until the lane paints, and lanes carry no message id, Regenerate or rating", () => {
		const turn = createCompareTurn(["A", "B"]);
		const lane = turn.lanes[0]!;
		expect(lane.root.querySelector(".compare-skeleton")).not.toBeNull();
		lane.view.finish("Hello");
		lane.settle();
		expect(lane.root.querySelector(".compare-skeleton")).toBeNull();
		expect(lane.root.querySelector(".copy-button")).not.toBeNull();
		expect(lane.root.querySelector(".regenerate-button, [data-feedback]")).toBeNull();
		expect(turn.root.querySelector("[data-message-id]")).toBeNull();
	});

	it("marks the chosen lane and offers Continue on the others once continuable", () => {
		const turn = createCompareTurn(["A", "B"]);
		turn.lanes.forEach((lane, i) => lane.setMessageId(`m${i}`));
		const foot = (i: number) => turn.lanes[i]!.root.querySelector<HTMLElement>(".compare-lane-foot")!;
		expect(foot(0).hidden && foot(1).hidden).toBe(true);
		turn.setChosen(0);
		turn.setContinuable(true);
		expect(turn.lanes[0]!.root.classList.contains("is-chosen")).toBe(true);
		expect(turn.lanes[0]!.root.querySelector<HTMLElement>(".compare-lane-chosen")!.hidden).toBe(false);
		expect(foot(0).hidden).toBe(true);
		expect(foot(1).hidden).toBe(false);
		const next = foot(1).querySelector<HTMLButtonElement>(".compare-continue")!;
		expect(next.textContent).toBe("Continue with this answer");
		expect(next.dataset.laneMessageId).toBe("m1");
	});
});

describe("compare in the chat", () => {
	let container: HTMLElement;

	beforeEach(() => {
		resetHistoryState();
		setHistoryState({ signedIn: true, historyOn: true });
		container = document.createElement("div");
		document.body.append(container);
		api.getConversation.mockReset();
		api.patchConversation.mockReset();
		api.patchConversation.mockResolvedValue({});
		stream.events = [];
		stream.bodies = [];
	});

	afterEach(() => {
		container.remove();
		vi.useRealTimers();
	});

	function chat() {
		return createChat({
			messages: container,
			onBusyChange: () => {},
			emptyState: () => document.createElement("div"),
			labelFor: (id) => ({ fast: "Llama 3.1 8B", smart: "Llama 3.3 70B" })[id] ?? null,
		});
	}

	// q1 -> s1 (single), then c0 | c1 (compare). The active leaf is c0.
	const tree: StoredMessage[] = [
		message({ id: "q1", seq: 1, role: "user", content: "Which is faster?" }),
		message({ id: "s1", seq: 2, role: "assistant", parentId: "q1", content: "Single answer" }),
		message({ id: "c0", seq: 3, role: "assistant", parentId: "q1", content: "Fast says", model: "fast", compareGroup: "g" }),
		message({ id: "c1", seq: 4, role: "assistant", parentId: "q1", content: "Smart says", model: "smart", compareGroup: "g", status: "stopped" }),
	];

	async function opened() {
		api.getConversation.mockResolvedValue({
			conversation: { id: "c9", title: "Compared", pinned: false, folderId: null, createdAt: 1, updatedAt: 1, activeLeafId: "c0" },
			messages: tree,
		});
		const c = chat();
		await c.openConversation("c9");
		return c;
	}

	it("reopens a compare turn as the compare view, counted once by the navigator", async () => {
		const c = await opened();
		const turns = container.querySelectorAll(".compare-turn");
		expect(turns).toHaveLength(1);
		const turn = turns[0] as HTMLElement;
		expect(turn.dataset.messageId).toBe("c0");
		expect([...turn.querySelectorAll(".compare-lane-model")].map((n) => n.textContent)).toEqual(["Llama 3.1 8B", "Llama 3.3 70B"]);
		expect(turn.querySelector(".compare-head .branch-count")?.textContent).toBe("2/2");
		expect(turn.querySelectorAll(".branch-nav")).toHaveLength(1);
		expect(turn.querySelector('[data-lane-message-id="c1"] .message-note')?.textContent).toBe("Stopped. What was written so far is saved.");
		expect(turn.querySelector(".compare-lane.is-chosen")?.getAttribute("data-lane-message-id")).toBe("c0");
		expect(c.history().map((m) => m.content)).toEqual([expect.any(String), "Which is faster?", "Fast says"]);

		// Back one version: the single answer, no compare view.
		turn.querySelector<HTMLButtonElement>('.branch-button[aria-label="Previous version"]')?.click();
		expect(container.querySelector(".compare-turn")).toBeNull();
		expect(container.querySelector('[data-message-id="s1"]')?.textContent).toContain("Single answer");
	});

	it("continues with another lane: it becomes the active leaf and the switch is saved", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const c = await opened();
		container.querySelector<HTMLButtonElement>('.compare-continue[data-lane-message-id="c1"]')?.click();
		expect(getHistoryState().activeLeafId).toBe("c1");
		const turn = container.querySelector<HTMLElement>(".compare-turn")!;
		expect(turn.dataset.messageId).toBe("c1");
		expect(turn.querySelector(".compare-lane.is-chosen")?.getAttribute("data-lane-message-id")).toBe("c1");
		expect(c.history().at(-1)?.content).toBe("Smart says");
		vi.advanceTimersByTime(400);
		expect(api.patchConversation).toHaveBeenCalledWith("c9", { activeLeafId: "c1" });
	});

	it("streams a saved compare turn into lanes and adds it to the tree as one group", async () => {
		const c = chat();
		c.setCompare([
			{ value: "fast", label: "Llama 3.1 8B" },
			{ value: "smart", label: "Llama 3.3 70B" },
		]);
		const ids = { conversationId: "c1", userMessageId: "u1", compareGroup: "g1" };
		stream.events = [
			{ type: "meta", data: { protocol: 2, lane: 0, model: "fast", ...ids, assistantMessageId: "a0" } },
			{ type: "meta", data: { protocol: 2, lane: 1, model: "smart", ...ids, assistantMessageId: "a1" } },
			{ type: "token", data: { lane: 1, text: "Second " } },
			{ type: "token", data: { lane: 0, text: "First" } },
			{ type: "token", data: { lane: 1, text: "lane" } },
			{ type: "usage", data: { lane: 1, completionTokens: 2 } },
			{ type: "done", data: { lane: 1 } },
			{ type: "error", data: { lane: 0, message: "That lane failed." } },
			{ type: "done", data: { lane: 0 } },
			{ type: "done", data: {} },
		];
		await c.sendMessage("Compare this");

		expect(stream.bodies[0]).toMatchObject({ compare: ["fast", "smart"], parentId: null, messages: [{ role: "user", content: "Compare this" }] });
		expect(stream.bodies[0]).not.toHaveProperty("model");
		const turn = container.querySelector<HTMLElement>(".compare-turn")!;
		expect(turn.dataset.messageId).toBe("a0");
		expect(turn.querySelector('[data-lane="0"] .message-error')?.textContent).toBe("That lane failed.");
		expect(turn.querySelector('[data-lane="1"] .message-body')?.textContent).toContain("Second lane");
		expect(turn.querySelector('[data-lane="1"] .message-usage')?.textContent).toBe("2 tokens");
		expect(container.querySelector('.user-turn[data-message-id="u1"]')).not.toBeNull();

		const state = getHistoryState();
		expect(state.conversationId).toBe("c1");
		expect(state.activeLeafId).toBe("a0");
		expect(state.messages.map((m) => [m.id, m.parentId, m.compareGroup, m.status])).toEqual([
			["u1", null, null, "complete"],
			["a0", "u1", "g1", "error"],
			["a1", "u1", "g1", "complete"],
		]);
		expect(c.isProcessing()).toBe(false);
	});

	it("an unsaved compare turn continues from the first answer, or the one picked", async () => {
		setHistoryState({ historyOn: false });
		const c = chat();
		c.setCompare([
			{ value: "fast", label: "A" },
			{ value: "smart", label: "B" },
		]);
		stream.events = [
			{ type: "meta", data: { protocol: 2, lane: 0, model: "fast" } },
			{ type: "meta", data: { protocol: 2, lane: 1, model: "smart" } },
			{ type: "token", data: { lane: 0, text: "Answer A" } },
			{ type: "token", data: { lane: 1, text: "Answer B" } },
			{ type: "done", data: { lane: 0 } },
			{ type: "done", data: { lane: 1 } },
			{ type: "done", data: {} },
		];
		await c.sendMessage("Hi");
		expect(stream.bodies[0]).not.toHaveProperty("parentId");
		expect(c.history().at(-1)).toEqual({ role: "assistant", content: "Answer A" });
		container.querySelector<HTMLButtonElement>('.compare-continue[data-lane="1"]')?.click();
		expect(c.history().at(-1)).toEqual({ role: "assistant", content: "Answer B" });

		// The next turn settles it: Continue goes from the older compare turn.
		stream.events = [{ type: "token", data: { text: "ok" } }, { type: "done", data: {} }];
		c.setCompare(null);
		await c.sendMessage("Next");
		expect(container.querySelector(".compare-continue")).toBeNull();
		expect((stream.bodies[1] as { messages: { content: string }[] }).messages.at(-2)?.content).toBe("Answer B");
	});
});
