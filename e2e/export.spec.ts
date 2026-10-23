/**
 * M5.3 in a real browser: exporting a conversation as Markdown and JSON,
 * from the header button (a guest chat) and from the sidebar's chat menu
 * (a saved chat), and printing it.
 *
 * Model calls are intercepted with crafted v2 streams and the saved-chat
 * routes are mocked, so nothing here costs inference. The print run saves
 * test-results/export/print-{en,ar}.png for a person to look at.
 */
import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";

const v2 = (frames: [string, unknown][]) =>
	frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const REPLY = [
	"Green tea wants water at **about 80 C**.",
	"",
	"```python",
	"def steep(minutes: int = 2) -> str:",
	'    return f"steep for {minutes} min"',
	"```",
	"",
	"Then drink it while it is warm.",
].join("\n");

const REPLY_AR = "الماء عند **80 درجة** تقريبًا هو الأفضل للشاي الأخضر.\n\nثم اشربه وهو دافئ.";

async function mockChat(page: Page, reply: string) {
	await page.route("**/api/chat/guest", (route) =>
		route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([
				["meta", { model: "@cf/meta/llama-3.1-8b-instruct-fp8", tier: "fast", protocol: 2 }],
				["token", { text: reply }],
				["usage", { promptTokens: 12, completionTokens: 40 }],
				["done", {}],
			]),
		}),
	);
}

async function send(page: Page, text: string) {
	const input = page.locator("#user-input");
	await expect(input).toBeEnabled();
	await input.fill(text);
	await page.locator("#send-button").click();
	await expect(page.locator(".assistant-message .message-usage").last()).toBeVisible();
}

async function contentOf(download: Download): Promise<string> {
	const path = await download.path();
	return readFile(path, "utf8");
}

async function exportVia(page: Page, item: string): Promise<Download> {
	await page.getByRole("button", { name: "Export chat" }).click();
	const waiting = page.waitForEvent("download");
	await page.getByRole("menuitem", { name: item }).click();
	return waiting;
}

test.use({ reducedMotion: "reduce" });

test("a guest exports the chat as Markdown and JSON", async ({ page }) => {
	await mockChat(page, REPLY);
	await page.goto("/");
	// Nothing to export before the first message.
	await expect(page.locator(".export-control")).toBeHidden();
	await send(page, "How hot should the water be for green tea?");
	await expect(page.getByRole("button", { name: "Export chat" })).toBeVisible();

	const md = await exportVia(page, "Markdown (.md)");
	expect(md.suggestedFilename()).toMatch(/^eleenai-how-hot-should-the-water-be-for-green-tea-\d{4}-\d{2}-\d{2}\.md$/);
	const text = await contentOf(md);
	expect(text).toMatch(/^# How hot should the water be for green tea\?\n\n_Exported from EleenAI on .+_\n/);
	expect(text).toContain("**You**\n\nHow hot should the water be for green tea?\n");
	expect(text).toContain(`**EleenAI**\n\n${REPLY}\n`);
	// The greeting the chat opens with is not part of the export.
	expect(text).not.toContain("Welcome to the ELEENAI Gateway");

	const json = await exportVia(page, "JSON (.json)");
	expect(json.suggestedFilename()).toMatch(/\.json$/);
	const body = JSON.parse(await contentOf(json));
	expect(body).toMatchObject({
		version: 1,
		title: "How hot should the water be for green tea?",
		messages: [
			{ role: "user", content: "How hot should the water be for green tea?" },
			{ role: "assistant", content: REPLY },
		],
	});
	expect(new Date(body.exportedAt).toString()).not.toBe("Invalid Date");
	// A guest chat has no branches to offer.
	await page.getByRole("button", { name: "Export chat" }).click();
	await expect(page.getByRole("menuitem", { name: "JSON with every branch (.json)" })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Export chat" })).toBeFocused();
});

test("the menu works from the keyboard", async ({ page }) => {
	await mockChat(page, REPLY);
	await page.goto("/");
	await send(page, "Keyboard only");
	const button = page.getByRole("button", { name: "Export chat" });
	await expect(button).toBeVisible();
	await button.focus();
	await expect(button).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menuitem", { name: "Markdown (.md)" })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menuitem", { name: "JSON (.json)" })).toBeFocused();
	const waiting = page.waitForEvent("download");
	await page.keyboard.press("Enter");
	const body = JSON.parse(await contentOf(await waiting));
	expect(body.messages[0]).toEqual({ role: "user", content: "Keyboard only" });
});

// ─── A saved chat, from the sidebar ─────────────────────────────────────────

const fakeClerk = `window.Clerk = {
	loaded: true,
	user: { id: "user_e2e", fullName: "Test User", imageUrl: null },
	session: { getToken: async () => "e2e-token" },
	load: async () => {},
	addListener: () => () => {},
	openSignIn: () => {},
	openSignUp: () => {},
	signOut: async () => {},
};`;

const SAVED = {
	conversation: { id: "c1", title: "Branchy chat", pinned: false, folderId: null, createdAt: 1, updatedAt: 2, activeLeafId: "a1" },
	messages: [
		{ id: "u1", parentId: null, seq: 1, role: "user", content: "Pick a colour", model: null, status: "complete", createdAt: Date.parse("2026-10-23T10:00:00Z") },
		{ id: "a1", parentId: "u1", seq: 2, role: "assistant", content: "Indigo.", model: "@cf/test/model", status: "complete", createdAt: Date.parse("2026-10-23T10:00:02Z") },
		{ id: "a2", parentId: "u1", seq: 3, role: "assistant", content: "Cyan.", model: "@cf/test/model", status: "complete", createdAt: Date.parse("2026-10-23T10:01:00Z") },
	],
};

async function mockSaved(page: Page) {
	await page.route("https://clerk.eleenai.xyz/**", (route) => route.fulfill({ contentType: "application/javascript", body: fakeClerk }));
	await page.route("**/api/v1/keys", (route) => route.fulfill({ json: { keys: [] } }));
	await page.route("**/api/v1/consent", (route) =>
		route.fulfill({ json: { consent: { history: true, memory: false, policyVersion: 1, updatedAt: 1 }, policyVersion: 1 } }),
	);
	await page.route(/\/api\/v1\/(conversations|folders|search)(\/|\?|$)/, (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/v1/folders") return route.fulfill({ json: { folders: [] } });
		if (url.pathname === "/api/v1/conversations/c1") return route.fulfill({ json: SAVED });
		const { activeLeafId: _leaf, ...summary } = SAVED.conversation;
		return route.fulfill({ json: { conversations: url.searchParams.get("deleted") ? [] : [summary], nextCursor: null } });
	});
}

test("a saved chat exports from the sidebar, branch on screen or every branch", async ({ page }) => {
	await mockSaved(page);
	await page.goto("/");
	const row = page.locator("#sidebar .sidebar-item", { hasText: "Branchy chat" });
	await row.hover();
	await row.getByRole("button", { name: "Options for Branchy chat" }).click();
	await page.getByRole("menuitem", { name: "Export" }).click();
	let waiting = page.waitForEvent("download");
	await page.getByRole("menuitem", { name: "Markdown (.md)" }).click();
	const md = await waiting;
	expect(md.suggestedFilename()).toMatch(/^eleenai-branchy-chat-\d{4}-\d{2}-\d{2}\.md$/);
	const text = await contentOf(md);
	expect(text).toContain("# Branchy chat\n");
	expect(text).toContain("**EleenAI**\n\nIndigo.\n");
	expect(text).not.toContain("Cyan.");

	await row.hover();
	await row.getByRole("button", { name: "Options for Branchy chat" }).click();
	await page.getByRole("menuitem", { name: "Export" }).click();
	waiting = page.waitForEvent("download");
	await page.getByRole("menuitem", { name: "JSON with every branch (.json)" }).click();
	const body = JSON.parse(await contentOf(await waiting));
	expect(body.messages).toEqual([
		{ role: "user", content: "Pick a colour", createdAt: "2026-10-23T10:00:00.000Z" },
		{ role: "assistant", content: "Indigo.", model: "@cf/test/model", createdAt: "2026-10-23T10:00:02.000Z" },
	]);
	expect(body.tree.activeLeafId).toBe("a1");
	expect(body.tree.messages.map((m: { id: string }) => m.id)).toEqual(["u1", "a1", "a2"]);
});

// ─── Print ──────────────────────────────────────────────────────────────────

for (const lang of ["en", "ar"] as const) {
	test(`print shows only the conversation, readable, in ${lang}`, async ({ page }) => {
		await page.addInitScript((l) => {
			if (sessionStorage.getItem("seeded")) return;
			sessionStorage.setItem("seeded", "1");
			localStorage.setItem("eleen.theme", "dark");
			localStorage.setItem("eleen.lang", l);
		}, lang);
		await mockChat(page, lang === "ar" ? REPLY_AR : REPLY);
		await page.goto("/");
		await send(page, lang === "ar" ? "ما درجة حرارة الماء المناسبة للشاي الأخضر؟" : "How hot should the water be for green tea?");

		// The action prints the page; the dialog itself is stubbed out.
		await page.evaluate(() => {
			(window as unknown as { __printed: number }).__printed = 0;
			window.print = () => {
				(window as unknown as { __printed: number }).__printed++;
			};
		});
		await page.locator("#export-button").click();
		await page.getByRole("menuitem", { name: lang === "ar" ? "طباعة / حفظ بصيغة PDF" : "Print / Save as PDF" }).click();
		await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);

		await page.emulateMedia({ media: "print" });
		for (const selector of ["#spline-bg", "#chat-scrim", ".message-input", ".auth-container", ".message-actions"]) {
			await expect(page.locator(selector).first()).toBeHidden();
		}
		await expect(page.locator(".print-header h1")).toBeVisible();
		await expect(page.locator(".assistant-message .message-body").last()).toBeVisible();
		// Dark ink on white, whatever the screen theme.
		const colours = await page.evaluate(() => ({
			body: getComputedStyle(document.body).backgroundColor,
			text: getComputedStyle(document.querySelector(".assistant-message .message-body p") as Element).color,
		}));
		expect(colours.body).toBe("rgb(255, 255, 255)");
		expect(colours.text).toBe("rgb(17, 17, 34)");
		// The conversation is not clipped to a viewport-high scroller.
		const overflow = await page.evaluate(() => getComputedStyle(document.getElementById("chat-messages") as Element).overflowY);
		expect(overflow).toBe("visible");

		if (lang === "ar") {
			await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
			const font = await page.evaluate(async () => {
				await document.fonts.ready;
				return [...document.fonts].some((f) => f.family.includes("Noto Sans Arabic") && f.status === "loaded");
			});
			expect(font).toBe(true);
			await expect(page.locator(".user-message p").last()).toHaveAttribute("dir", "auto");
		}
		await page.screenshot({ path: `test-results/export/print-${lang}.png`, fullPage: true });
		// A real print layout too, for review: the conversation flows across pages.
		await page.pdf({ path: `test-results/export/print-${lang}.pdf` });
	});
}
