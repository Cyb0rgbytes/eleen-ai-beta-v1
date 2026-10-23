/**
 * M4.3 in a real browser: saved chats send ids instead of history, adopt the
 * ids the stream's meta event returns, and branch on Regenerate and Edit
 * with a ‹ n/m › navigator. A guest chat is unchanged.
 *
 * Signed-in state is faked with a stand-in for the Clerk SDK served from
 * Clerk's own script URL (as in consent.spec.ts), consent says history is
 * on, and every chat and history route is mocked: nothing here reaches a
 * model or a database.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const v2 = (frames: [string, unknown][]) =>
	frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

function fakeClerk(signedIn: boolean): string {
	const user = signedIn ? `{ id: "user_e2e", fullName: "Test User", imageUrl: null }` : "null";
	const session = signedIn ? `{ getToken: async () => "e2e-token" }` : "null";
	return `window.Clerk = {
		loaded: true,
		user: ${user},
		session: ${session},
		load: async () => {},
		addListener: () => () => {},
		openSignIn: () => {},
		openSignUp: () => {},
		signOut: async () => {},
	};`;
}

type Body = Record<string, unknown>;

interface Mock {
	/** Every chat request body, in order. */
	chats: Body[];
	/** Every history request other than a list read. */
	history: { method: string; path: string; body: unknown }[];
	/** The detail GET /api/v1/conversations/:id answers with. */
	detail: unknown;
}

/**
 * Mocks for a saved chat. Each chat reply mints ids the way the server does:
 * one conversation, then u<n>/a<n> per call (a regenerate gets only a<n>).
 */
async function savedChat(page: Page, { signedIn = true }: { signedIn?: boolean } = {}): Promise<Mock> {
	const mock: Mock = { chats: [], history: [], detail: null };
	await page.route("https://clerk.eleenai.xyz/**", (route) =>
		route.fulfill({ contentType: "application/javascript", body: fakeClerk(signedIn) }),
	);
	await page.route("**/api/v1/keys", (route) => route.fulfill({ json: { keys: [] } }));
	await page.route("**/api/v1/consent", (route) =>
		route.fulfill({ json: { consent: { history: true, memory: false, policyVersion: 1, updatedAt: 1 }, policyVersion: 1 } }),
	);
	await page.route("**/api/v1/folders**", (route) => route.fulfill({ json: { folders: [] } }));
	await page.route(/\/api\/v1\/conversations(\/[^?]*)?(\?.*)?$/, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET" && path === "/api/v1/conversations") {
			return route.fulfill({ json: { conversations: [], nextCursor: null } });
		}
		const raw = request.postData();
		mock.history.push({ method: request.method(), path, body: raw ? JSON.parse(raw) : null });
		if (request.method() === "GET") return route.fulfill({ json: mock.detail });
		const id = decodeURIComponent(path.split("/")[4] ?? "");
		return route.fulfill({
			json: { conversation: { id, title: "Saved", pinned: false, folderId: null, createdAt: 1, updatedAt: 2 } },
		});
	});

	let turn = 0;
	await page.route("**/api/chat", async (route: Route) => {
		const body = JSON.parse(route.request().postData() ?? "{}") as Body;
		mock.chats.push(body);
		turn++;
		const regenerate = typeof body.replyTo === "string";
		await route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([
				[
					"meta",
					{
						model: "m",
						protocol: 2,
						conversationId: "c1",
						...(regenerate ? {} : { userMessageId: `u${turn}` }),
						assistantMessageId: `a${turn}`,
					},
				],
				["token", { text: `Reply ${turn}` }],
				["usage", { completionTokens: 3 }],
				["done", {}],
			]),
		});
	});
	return mock;
}

/** Load the page and wait until consent (history on) has been read. */
async function open(page: Page) {
	const consent = page.waitForResponse((r) => r.url().includes("/api/v1/consent"));
	await page.goto("/");
	await consent;
	await expect(page.locator("#logout-button")).toBeVisible();
	// The consent answer is applied once its body is parsed.
	await page.waitForTimeout(150);
}

async function send(page: Page, text: string) {
	const input = page.locator("#user-input");
	await expect(input).toBeEnabled();
	await input.fill(text);
	await page.locator("#send-button").click();
	await expect(page.locator("#send-button")).toHaveAttribute("title", "Send");
}

const reply = (page: Page, id: string) => page.locator(`.assistant-message[data-message-id="${id}"]`);
const userTurn = (page: Page, id: string) => page.locator(`.user-turn[data-message-id="${id}"]`);

test("a saved chat sends the new message with its parent, and adopts the ids it is given", async ({ page }) => {
	const mock = await savedChat(page);
	await open(page);

	await send(page, "first question");
	await expect(reply(page, "a1")).toContainText("Reply 1");
	await expect(userTurn(page, "u1")).toContainText("first question");
	expect(mock.chats[0]).toMatchObject({ parentId: null, messages: [{ role: "user", content: "first question" }], protocol: 2 });
	expect(mock.chats[0]).not.toHaveProperty("conversationId");
	expect(await page.evaluate(() => window.chat?.currentConversationId())).toBe("c1");

	await send(page, "second question");
	await expect(reply(page, "a2")).toContainText("Reply 2");
	expect(mock.chats[1]).toMatchObject({
		conversationId: "c1",
		parentId: "a1",
		messages: [{ role: "user", content: "second question" }],
	});
	// The visible thread, for WebMCP.
	expect(await page.evaluate(() => window.chat?.history().length)).toBe(5);
});

test("regenerate adds a sibling reply, and the navigator switches back and saves the branch", async ({ page }) => {
	const mock = await savedChat(page);
	await open(page);
	await send(page, "tell me a joke");
	await expect(reply(page, "a1")).toContainText("Reply 1");

	await reply(page, "a1").hover();
	await reply(page, "a1").locator(".regenerate-button").click();
	await expect(reply(page, "a2")).toContainText("Reply 2");
	await expect(reply(page, "a1")).toHaveCount(0);
	expect(mock.chats[1]).toEqual(expect.objectContaining({ conversationId: "c1", replyTo: "u1", messages: [] }));
	expect(mock.chats[1]).not.toHaveProperty("parentId");

	const nav = reply(page, "a2").locator(".branch-nav");
	await expect(nav.locator(".branch-count")).toHaveText("2/2");
	await expect(nav.locator(".sr-only")).toHaveText("Version 2 of 2");
	await expect(nav.getByRole("button", { name: "Next version" })).toBeDisabled();

	await nav.getByRole("button", { name: "Previous version" }).click();
	await expect(reply(page, "a1")).toContainText("Reply 1");
	await expect(reply(page, "a1").locator(".branch-count")).toHaveText("1/2");
	// Only the newest reply on the visible branch offers Regenerate.
	await expect(page.locator(".regenerate-button")).toHaveCount(1);
	await expect.poll(() => mock.history.filter((r) => r.method === "PATCH")).toEqual([
		{ method: "PATCH", path: "/api/v1/conversations/c1", body: { activeLeafId: "a1" } },
	]);
});

test("editing a message sends it as a sibling and shows a navigator on the user turn", async ({ page }) => {
	const mock = await savedChat(page);
	await open(page);
	await send(page, "first");
	await send(page, "second");
	await expect(reply(page, "a2")).toContainText("Reply 2");

	const turn = userTurn(page, "u2");
	await turn.hover();
	await turn.getByRole("button", { name: "Edit message" }).click();
	const editor = turn.getByRole("textbox", { name: "Edit message" });
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("second");

	// Escape cancels and nothing is sent.
	await page.keyboard.press("Escape");
	await expect(editor).toHaveCount(0);
	expect(mock.chats).toHaveLength(2);

	await turn.hover();
	await turn.getByRole("button", { name: "Edit message" }).click();
	await turn.getByRole("textbox", { name: "Edit message" }).fill("second, reworded");
	await turn.getByRole("button", { name: "Save and send" }).click();

	await expect(reply(page, "a3")).toContainText("Reply 3");
	expect(mock.chats[2]).toMatchObject({
		conversationId: "c1",
		parentId: "a1",
		messages: [{ role: "user", content: "second, reworded" }],
	});
	await expect(reply(page, "a2")).toHaveCount(0);
	await expect(userTurn(page, "u3").locator(".branch-count")).toHaveText("2/2");

	await userTurn(page, "u3").getByRole("button", { name: "Previous version" }).click();
	await expect(userTurn(page, "u2")).toContainText("second");
	await expect(reply(page, "a2")).toContainText("Reply 2");
	await expect.poll(() => mock.history.filter((r) => r.method === "PATCH").at(-1)?.body).toEqual({ activeLeafId: "a2" });
});

test("Stop keeps the stopped reply in the tree, and the next turn follows it", async ({ page }) => {
	const mock = await savedChat(page);
	// A reply that streams its meta and a few words, then waits to be stopped.
	await page.addInitScript(() => {
		const real = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const w = window as unknown as { __hold?: boolean; __held?: string[] };
			if (!w.__hold || !url.endsWith("/api/chat")) return real(input, init);
			w.__hold = false;
			(w.__held ??= []).push(String(init?.body ?? ""));
			const encoder = new TextEncoder();
			const frames =
				'event: meta\ndata: {"protocol":2,"conversationId":"c1","userMessageId":"uh","assistantMessageId":"ah"}\n\n' +
				'event: token\ndata: {"text":"Partial answer"}\n\n';
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(frames));
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		};
	});
	await open(page);
	await send(page, "first");
	await expect(reply(page, "a1")).toContainText("Reply 1");

	await page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = true));
	const input = page.locator("#user-input");
	await input.fill("write a long essay");
	await page.locator("#send-button").click();
	await expect(reply(page, "ah")).toContainText("Partial answer");
	// Past the double-click guard.
	await page.waitForTimeout(600);
	await page.locator("#send-button").click();

	await expect(reply(page, "ah").locator(".message-note")).toHaveText("Stopped. What was written so far is saved.");
	await expect(reply(page, "ah")).toContainText("Partial answer");
	await expect(userTurn(page, "uh")).toBeVisible();

	await send(page, "go on");
	await expect(reply(page, "a2")).toContainText("Reply 2");
	expect(mock.chats.at(-1)).toMatchObject({ conversationId: "c1", parentId: "ah" });
});

test("a guest chat still sends its history and no saved-chat ids", async ({ page }) => {
	const mock = await savedChat(page, { signedIn: false });
	let guestBody: Body = {};
	await page.route("**/api/chat/guest", async (route) => {
		guestBody = JSON.parse(route.request().postData() ?? "{}") as Body;
		await route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([["meta", { model: "m", protocol: 2 }], ["token", { text: "Hello guest" }], ["done", {}]]),
		});
	});
	await page.goto("/");
	await send(page, "hi");
	await expect(page.locator(".assistant-message").last()).toContainText("Hello guest");

	expect(guestBody.messages).toEqual([
		{ role: "assistant", content: expect.any(String) },
		{ role: "user", content: "hi" },
	]);
	for (const key of ["conversationId", "parentId", "replyTo"]) expect(guestBody).not.toHaveProperty(key);
	await expect(page.locator("[data-message-id]")).toHaveCount(0);
	await expect(page.locator(".edit-button, .branch-nav")).toHaveCount(0);
	expect(mock.chats).toHaveLength(0);
});

test("openConversation shows the saved branch and switches an edited first turn", async ({ page }) => {
	const mock = await savedChat(page);
	const m = (id: string, seq: number, role: "user" | "assistant", parentId: string | null, content: string, status = "complete") => ({
		id,
		parentId,
		seq,
		role,
		content,
		reasoning: role === "assistant" && id === "b1" ? "Weighing it up" : null,
		model: null,
		status,
		compareGroup: null,
		completionTokens: role === "assistant" ? 5 : null,
		createdAt: seq,
	});
	// q1 -> b1 | b2 (regenerated); q2 is q1 edited, -> b3.
	mock.detail = {
		conversation: { id: "c9", title: "Branched", pinned: false, folderId: null, createdAt: 1, updatedAt: 5, activeLeafId: "b2" },
		messages: [
			m("q1", 1, "user", null, "Original question"),
			m("b1", 2, "assistant", "q1", "First answer"),
			m("b2", 3, "assistant", "q1", "Second answer", "stopped"),
			m("q2", 4, "user", null, "Edited question"),
			m("b3", 5, "assistant", "q2", "Answer to the edit"),
		],
	};
	await open(page);
	await page.evaluate(() => window.chat?.openConversation("c9"));

	await expect(userTurn(page, "q1")).toContainText("Original question");
	await expect(userTurn(page, "q1").locator(".branch-count")).toHaveText("1/2");
	await expect(reply(page, "b2")).toContainText("Second answer");
	await expect(reply(page, "b2").locator(".message-note")).toHaveText("Stopped. What was written so far is saved.");
	await expect(reply(page, "b2").locator(".branch-count")).toHaveText("2/2");
	expect(await page.evaluate(() => window.chat?.currentConversationId())).toBe("c9");

	await reply(page, "b2").getByRole("button", { name: "Previous version" }).click();
	await expect(reply(page, "b1").locator(".reasoning")).toBeVisible();
	await expect(reply(page, "b1").locator(".message-usage")).toHaveText("5 tokens");

	await userTurn(page, "q1").getByRole("button", { name: "Next version" }).click();
	await expect(userTurn(page, "q2")).toContainText("Edited question");
	await expect(reply(page, "b3")).toContainText("Answer to the edit");
	await expect(userTurn(page, "q2").locator(".branch-count")).toHaveText("2/2");
	// The switch is saved, ending where the reader ended.
	await expect.poll(() => mock.history.filter((r) => r.method === "PATCH").at(-1)).toEqual({
		method: "PATCH",
		path: "/api/v1/conversations/c9",
		body: { activeLeafId: "b3" },
	});

	// A new turn follows the branch on screen.
	await send(page, "follow up");
	expect(mock.chats.at(-1)).toMatchObject({ conversationId: "c9", parentId: "b3" });
});
