import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetFact, deleteAllConversations } from "./api";
import { HISTORY_DELETED_EVENT, createPrivacyPanel } from "./panel";
import { json, stubServer, type Handler } from "./test-server";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

const consent = (memory: boolean) => () => json(200, { consent: { history: true, memory, policyVersion: 1, updatedAt: 1 }, policyVersion: 1 });
const facts = (...list: [string, string][]) => () => json(200, { entries: list.map(([id, fact]) => ({ id, fact, createdAt: 1 })) });

function setup(routes: Record<string, Handler>) {
	const server = stubServer({ "GET /api/v1/consent": consent(true), "GET /api/v1/memory": facts(), ...routes });
	const panel = createPrivacyPanel();
	panel.open();
	const root = panel.element;
	const q = <T extends Element>(selector: string) => root.querySelector(selector) as T;
	const buttonByText = (text: string) =>
		[...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text && !b.closest("[hidden]")) as HTMLButtonElement;
	return {
		server,
		panel,
		root,
		history: q<HTMLInputElement>("#privacy-history"),
		memory: q<HTMLInputElement>("#privacy-memory"),
		rows: () => [...root.querySelectorAll<HTMLElement>(".memory-row")],
		state: () => root.querySelector(".memory-body .privacy-state")?.textContent ?? "",
		buttonByText,
	};
}

describe("memory and privacy panel", () => {
	it("shows the saved choices and every remembered fact, as text", async () => {
		const ui = setup({ "GET /api/v1/memory": facts(["a", "Name is Omar"], ["b", '<img src=x onerror="window.__xss=1">']) });
		await vi.waitFor(() => expect(ui.rows()).toHaveLength(2));
		expect(ui.history.checked).toBe(true);
		expect(ui.memory.checked).toBe(true);
		expect(ui.history.disabled).toBe(false);
		expect(ui.rows()[1]?.querySelector(".memory-fact")?.textContent).toBe('<img src=x onerror="window.__xss=1">');
		expect(ui.root.querySelector("img")).toBeNull();
		expect(ui.rows()[0]?.querySelector(".memory-forget")?.textContent).toBe("Forget: Name is Omar");
	});

	it("designs the empty state differently for memory off and memory on", async () => {
		const off = setup({ "GET /api/v1/consent": consent(false) });
		await vi.waitFor(() => expect(off.state()).toContain("Memory is off"));
		off.panel.close();
		document.body.replaceChildren();

		const on = setup({});
		await vi.waitFor(() => expect(on.state()).toContain("Nothing remembered yet"));
	});

	it("shows a loading skeleton, then a designed error with a working retry", async () => {
		let fail = true;
		const ui = setup({ "GET /api/v1/memory": () => (fail ? json(500, { error: "boom" }) : facts(["a", "Likes tea"])()) });
		expect(ui.root.querySelector(".memory-skeleton")).not.toBeNull();
		await vi.waitFor(() => expect(ui.root.querySelector(".privacy-state.is-error")).not.toBeNull());
		expect(ui.root.querySelector(".privacy-state.is-error")?.textContent).toContain("Could not load what EleenAI remembers.");
		expect(ui.root.textContent).not.toContain("boom");
		fail = false;
		ui.buttonByText("Try again").click();
		await vi.waitFor(() => expect(ui.rows()).toHaveLength(1));
	});

	it("forgets one fact with DELETE /api/v1/memory/:id", async () => {
		const ui = setup({
			"GET /api/v1/memory": facts(["a/1", "Name is Omar"], ["b", "Likes tea"]),
			"DELETE *": () => json(204),
		});
		await vi.waitFor(() => expect(ui.rows()).toHaveLength(2));
		ui.rows()[0]?.querySelector<HTMLButtonElement>(".memory-forget")?.click();
		await vi.waitFor(() => expect(ui.rows()).toHaveLength(1));
		expect(ui.server.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/v1/memory/a%2F1" });
		expect(ui.rows()[0]?.textContent).toContain("Likes tea");
		expect(document.activeElement).toBe(ui.rows()[0]?.querySelector(".memory-forget"));
	});

	it("forgets everything only after the inline confirm", async () => {
		const ui = setup({ "GET /api/v1/memory": facts(["a", "x"], ["b", "y"]), "DELETE /api/v1/memory": () => json(204) });
		await vi.waitFor(() => expect(ui.rows()).toHaveLength(2));
		ui.buttonByText("Forget everything").click();
		expect(ui.server.calls.some((c) => c.method === "DELETE")).toBe(false);
		expect(document.activeElement?.textContent).toBe("Cancel");
		ui.buttonByText("Yes, forget everything").click();
		await vi.waitFor(() => expect(ui.rows()).toHaveLength(0));
		expect(ui.server.calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: "/api/v1/memory", body: null }]);
		expect(ui.root.textContent).toContain("EleenAI no longer remembers anything about you.");
	});

	it("warns before turning memory off, and saves only on confirm", async () => {
		const ui = setup({
			"GET /api/v1/memory": facts(["a", "x"]),
			"PUT /api/v1/consent": (call) => json(200, { consent: { ...call.body, policyVersion: 1, updatedAt: 2 }, policyVersion: 1 }),
		});
		await vi.waitFor(() => expect(ui.rows()).toHaveLength(1));
		ui.memory.click();
		expect(ui.memory.checked).toBe(true);
		expect(ui.root.textContent).toContain("Turning memory off also forgets everything");
		expect(ui.server.calls.some((c) => c.method === "PUT")).toBe(false);

		ui.buttonByText("Keep memory on").click();
		expect(ui.server.calls.some((c) => c.method === "PUT")).toBe(false);
		expect(ui.memory.checked).toBe(true);

		ui.memory.click();
		ui.buttonByText("Turn off and forget").click();
		await vi.waitFor(() => expect(ui.memory.checked).toBe(false));
		expect(ui.server.calls.filter((c) => c.method === "PUT")).toEqual([
			{ method: "PUT", path: "/api/v1/consent", body: { history: true, memory: false } },
		]);
		expect(ui.rows()).toHaveLength(0);
		expect(ui.state()).toContain("Memory is off");
	});

	it("saves the history switch as it changes, and puts it back if the save fails", async () => {
		const ui = setup({ "PUT /api/v1/consent": () => json(500, {}) });
		await vi.waitFor(() => expect(ui.history.disabled).toBe(false));
		ui.history.click();
		await vi.waitFor(() => expect(ui.root.textContent).toContain("Could not save that change."));
		expect(ui.history.checked).toBe(true);
		expect(ui.server.calls.find((c) => c.method === "PUT")?.body).toEqual({ history: false, memory: true });
	});

	it("deletes all conversations only after the inline confirm", async () => {
		const ui = setup({ "DELETE /api/v1/conversations": () => json(204) });
		const deleted = vi.fn();
		window.addEventListener(HISTORY_DELETED_EVENT, deleted);
		try {
			ui.buttonByText("Delete all my conversations").click();
			expect(ui.root.textContent).toContain("This cannot be undone.");
			ui.buttonByText("Cancel").click();
			expect(ui.server.calls.some((c) => c.path === "/api/v1/conversations")).toBe(false);

			ui.buttonByText("Delete all my conversations").click();
			ui.buttonByText("Yes, delete them all").click();
			await vi.waitFor(() => expect(ui.root.textContent).toContain("All your saved conversations are deleted."));
			expect(ui.server.calls.filter((c) => c.path === "/api/v1/conversations")).toEqual([
				{ method: "DELETE", path: "/api/v1/conversations", body: null },
			]);
			expect(deleted).toHaveBeenCalledOnce();
		} finally {
			window.removeEventListener(HISTORY_DELETED_EVENT, deleted);
		}
	});

	it("forgets what it showed on sign-out", async () => {
		const ui = setup({ "GET /api/v1/memory": facts(["a", "x"]) });
		await vi.waitFor(() => expect(ui.rows()).toHaveLength(1));
		ui.panel.reset();
		expect(ui.root.open).toBe(false);
		expect(ui.rows()).toHaveLength(0);
	});
});

describe("delete helpers", () => {
	it("count an already-forgotten fact as forgotten, but never a missing history route as deleted", async () => {
		stubServer({});
		expect(await forgetFact("gone")).toBe(true);
		expect(await deleteAllConversations()).toBe(false);
	});
});
