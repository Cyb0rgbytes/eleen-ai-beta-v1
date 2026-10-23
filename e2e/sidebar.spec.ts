/**
 * M4.4 in a real browser: the conversation sidebar.
 *
 * Signed-in state is faked by serving a stand-in for the Clerk SDK from
 * Clerk's own script URL (as in consent.spec.ts). Consent is answered with
 * history on, and every conversation, folder and search route is served
 * from an in-memory list here, recording what the page sent.
 *
 * Opening a saved chat is M4.3's chat.openConversation; these tests check
 * the sidebar calls it, not what it renders.
 */
import { expect, test, type Page } from "@playwright/test";

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

interface Conv {
	id: string;
	title: string;
	pinned: boolean;
	folderId: string | null;
	createdAt: number;
	updatedAt: number;
	deleted?: boolean;
}

interface Api {
	requests: { method: string; path: string; body: unknown }[];
	conversations: Conv[];
	folders: { id: string; name: string; position: number }[];
}

const conv = (id: string, title: string, updatedAt: number, extra: Partial<Conv> = {}): Conv => ({
	id,
	title,
	pinned: false,
	folderId: null,
	createdAt: 1,
	updatedAt,
	...extra,
});

async function mockApi(page: Page, { signedIn = true }: { signedIn?: boolean } = {}): Promise<Api> {
	const api: Api = {
		requests: [],
		conversations: [
			conv("c1", "Pinned plan", 50, { pinned: true }),
			conv("c2", "Tea brewing guide", 40),
			conv("c3", "Weekend trip", 30),
			conv("c4", "Filed away", 20, { folderId: "f1" }),
		],
		folders: [{ id: "f1", name: "Work", position: 0 }],
	};
	await page.route("https://clerk.eleenai.xyz/**", (route) =>
		route.fulfill({ contentType: "application/javascript", body: fakeClerk(signedIn) }),
	);
	await page.route("**/api/v1/keys", (route) => route.fulfill({ json: { keys: [] } }));
	await page.route("**/api/v1/consent", (route) =>
		route.fulfill({ json: { consent: { history: true, memory: false, policyVersion: 1, updatedAt: 1 }, policyVersion: 1 } }),
	);
	const summary = ({ deleted: _deleted, ...c }: Conv) => c;
	const visible = () =>
		api.conversations
			.filter((c) => !c.deleted)
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
	await page.route(/\/api\/v1\/(conversations|folders|search)(\/|\?|$)/, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const raw = request.postData();
		const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
		api.requests.push({ method: request.method(), path: url.pathname, body });
		const parts = url.pathname.split("/").slice(3); // ["conversations", id?, "restore"?]
		const [kind, id, action] = parts;
		if (kind === "folders") return route.fulfill({ json: { folders: api.folders } });
		if (kind === "search") {
			const q = (url.searchParams.get("q") ?? "").toLowerCase();
			const results = visible()
				.filter((c) => c.title.toLowerCase().includes(q))
				.map((c) => ({ conversationId: c.id, messageId: `m-${c.id}`, title: c.title, snippet: `How to brew tea well, from ${c.title}`, createdAt: 1 }));
			return route.fulfill({ json: { results } });
		}
		if (!id) {
			const folder = url.searchParams.get("folder");
			const list = visible().filter((c) => !folder || c.folderId === folder);
			return route.fulfill({ json: { conversations: list.map(summary), nextCursor: null } });
		}
		const target = api.conversations.find((c) => c.id === decodeURIComponent(id));
		if (!target) return route.fulfill({ status: 404, json: { error: "not found" } });
		if (action === "restore") {
			target.deleted = false;
			return route.fulfill({ json: { conversation: summary(target) } });
		}
		if (request.method() === "PATCH") {
			Object.assign(target, body);
			return route.fulfill({ json: { conversation: summary(target) } });
		}
		if (request.method() === "DELETE") {
			target.deleted = true;
			return route.fulfill({ status: 204 });
		}
		return route.fulfill({ json: { conversation: { ...summary(target), activeLeafId: null }, messages: [] } });
	});
	return api;
}

const sidebar = (page: Page) => page.locator("#sidebar");
const item = (page: Page, title: string) => sidebar(page).locator(".sidebar-item", { hasText: title });

async function openOptions(page: Page, title: string) {
	const row = item(page, title);
	await row.hover();
	await row.getByRole("button", { name: `Options for ${title}` }).click();
	return page.getByRole("menu");
}

/** Replace the chat's methods with recorders; the sidebar holds the same object. */
async function spyOnChat(page: Page) {
	await page.waitForFunction(() => Boolean((window as unknown as { chat?: unknown }).chat));
	await page.evaluate(() => {
		const w = window as unknown as { __calls: unknown[][]; chat: Record<string, unknown> };
		w.__calls = [];
		const chat = w.chat;
		const newChat = chat.newChat as () => void;
		chat.openConversation = (...args: unknown[]) => {
			w.__calls.push(["openConversation", ...args]);
			return Promise.resolve();
		};
		chat.newChat = () => {
			w.__calls.push(["newChat"]);
			newChat();
		};
	});
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls);

test.use({ reducedMotion: "reduce" });

test("the list shows Pinned, Folders and Recent beside the chat, without covering it", async ({ page }) => {
	await mockApi(page);
	await page.goto("/");
	await expect(sidebar(page)).toBeVisible();
	await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
	await expect(sidebar(page).locator(".is-pinned .sidebar-title")).toHaveText(["Pinned plan"]);
	await expect(sidebar(page).locator(".is-recent .sidebar-title")).toHaveText(["Tea brewing guide", "Weekend trip"]);
	await expect(sidebar(page).getByRole("button", { name: "Show Work" })).toBeVisible();

	const panel = await sidebar(page).boundingBox();
	const composer = await page.locator(".message-input").boundingBox();
	expect(panel && composer && composer.x >= panel.x + panel.width).toBe(true);

	await spyOnChat(page);
	await item(page, "Weekend trip").locator(".sidebar-link").click();
	expect(await calls(page)).toEqual([["openConversation", "c3"]]);

	// A folder lists its chats on first open.
	await sidebar(page).getByRole("button", { name: "Show Work" }).click();
	await expect(sidebar(page).locator(".sidebar-folder .sidebar-item .sidebar-title")).toHaveText(["Filed away"]);
	await expect(sidebar(page).getByRole("button", { name: "Hide Work" })).toHaveAttribute("aria-expanded", "true");
});

test("rename sends PATCH with the trimmed title", async ({ page }) => {
	const api = await mockApi(page);
	await page.goto("/");
	const menu = await openOptions(page, "Weekend trip");
	await menu.getByRole("menuitem", { name: "Rename" }).click();
	const field = sidebar(page).getByRole("textbox", { name: "Name for this chat" });
	await expect(field).toBeFocused();
	await field.fill("  Beach weekend  ");
	await field.press("Enter");
	await expect(item(page, "Beach weekend")).toBeVisible();
	await expect.poll(() => api.requests.filter((r) => r.method === "PATCH")).toEqual([
		{ method: "PATCH", path: "/api/v1/conversations/c3", body: { title: "Beach weekend" } },
	]);
});

test("pin moves a chat into Pinned", async ({ page }) => {
	const api = await mockApi(page);
	await page.goto("/");
	const menu = await openOptions(page, "Tea brewing guide");
	await menu.getByRole("menuitem", { name: "Pin", exact: true }).click();
	await expect(sidebar(page).locator(".is-pinned .sidebar-title")).toHaveText(["Pinned plan", "Tea brewing guide"]);
	await expect(sidebar(page).locator(".is-recent .sidebar-title")).toHaveText(["Weekend trip"]);
	await expect.poll(() => api.requests.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ pinned: true }]);
});

test("delete removes a chat at once, and Undo restores it", async ({ page }) => {
	const api = await mockApi(page);
	await page.goto("/");
	const menu = await openOptions(page, "Weekend trip");
	await menu.getByRole("menuitem", { name: "Delete" }).click();
	await expect(item(page, "Weekend trip")).toHaveCount(0);
	const toast = page.locator(".toast", { hasText: "Chat deleted." });
	await expect(toast).toBeVisible();
	await toast.getByRole("button", { name: "Undo" }).click();
	await expect(item(page, "Weekend trip")).toBeVisible();
	await expect(page.locator(".toast", { hasText: "Chat restored." })).toBeVisible();
	expect(api.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual([
		"DELETE /api/v1/conversations/c3",
		"POST /api/v1/conversations/c3/restore",
	]);
});

test("search shows a highlighted hit, opens it at the message, and Escape clears", async ({ page }) => {
	await mockApi(page);
	await page.goto("/");
	await spyOnChat(page);
	const field = sidebar(page).getByRole("searchbox", { name: "Search chats" });
	await field.fill("tea");
	const hit = sidebar(page).locator(".sidebar-hit");
	await expect(hit).toHaveCount(1);
	await expect(hit.locator(".sidebar-hit-title mark")).toHaveText("Tea");
	await expect(hit.locator(".sidebar-hit-snippet mark")).toHaveText(["tea", "Tea"]);
	await expect(sidebar(page).locator(".sidebar-sections")).toBeHidden();
	await hit.click();
	expect(await calls(page)).toEqual([["openConversation", "c2", "m-c2"]]);

	await field.fill("nothing-like-this");
	await expect(sidebar(page).getByText('No chats match "nothing-like-this".')).toBeVisible();
	await field.press("Escape");
	await expect(field).toHaveValue("");
	await expect(sidebar(page).locator(".sidebar-sections")).toBeVisible();
});

test("New chat starts a fresh chat and focuses the composer", async ({ page }) => {
	await mockApi(page);
	await page.goto("/");
	await spyOnChat(page);
	await sidebar(page).getByRole("button", { name: "New chat" }).click();
	expect(await calls(page)).toEqual([["newChat"]]);
	await expect(page.locator("#user-input")).toBeFocused();
});

test("on a phone it is a drawer: the toggle opens it, Escape closes it", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page);
	await page.goto("/");
	const toggle = page.getByRole("button", { name: "Open conversations" });
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(sidebar(page)).toBeHidden();

	await toggle.click();
	await expect(sidebar(page)).toBeVisible();
	await expect(page.locator("#sidebar-scrim")).toBeVisible();
	await expect(sidebar(page).getByRole("searchbox", { name: "Search chats" })).toBeFocused();
	await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");

	await page.keyboard.press("Escape");
	await expect(sidebar(page)).toBeHidden();
	await expect(page.locator("#sidebar-scrim")).toBeHidden();
	await expect(page.locator("#sidebar-toggle")).toBeFocused();

	// The scrim closes it too, and choosing a chat closes it.
	await page.locator("#sidebar-toggle").click();
	await page.locator("#sidebar-scrim").click({ position: { x: 370, y: 400 } });
	await expect(sidebar(page)).toBeHidden();
	await page.locator("#sidebar-toggle").click();
	await spyOnChat(page);
	await item(page, "Weekend trip").locator(".sidebar-link").click();
	await expect(sidebar(page)).toBeHidden();
	expect(await calls(page)).toEqual([["openConversation", "c3"]]);
});

test("a guest sees no sidebar and no toggle", async ({ page }) => {
	const api = await mockApi(page, { signedIn: false });
	await page.goto("/");
	await expect(page.locator("#login-button")).toBeVisible();
	await expect(sidebar(page)).toBeHidden();
	await expect(page.locator("#sidebar-toggle")).toBeHidden();
	expect(await page.evaluate(() => document.documentElement.dataset.sidebar)).toBeUndefined();
	expect(api.requests).toEqual([]);
});

test("in Arabic the sidebar sits on the right, with a screenshot", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("eleen.lang", "ar"));
	await page.setViewportSize({ width: 1280, height: 900 });
	await mockApi(page);
	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
	await expect(sidebar(page).locator(".is-recent .sidebar-item")).toHaveCount(2);
	const box = await sidebar(page).boundingBox();
	expect(box && Math.round(box.x + box.width)).toBe(1280);
	const toggle = await page.locator("#sidebar-toggle").boundingBox();
	expect(toggle && toggle.x > 1280 - 80).toBe(true);
	await page.screenshot({ path: "test-results/sidebar/rtl-open.png" });
});
