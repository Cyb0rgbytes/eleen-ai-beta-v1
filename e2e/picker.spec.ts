/**
 * M3.6 in a real browser: the model picker, and the reasoning panel on the
 * v2 stream. The listing comes from the local Worker's real /api/v1/models;
 * every chat reply is intercepted, so nothing here costs inference.
 */
import { expect, test, type Page } from "@playwright/test";

const v2 = (frames: [string, unknown][]) =>
	frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

async function captureChat(page: Page, frames: [string, unknown][]) {
	const bodies: Record<string, unknown>[] = [];
	await page.route("**/api/chat/guest", async (route) => {
		bodies.push(JSON.parse(route.request().postData() ?? "{}"));
		await route.fulfill({ headers: { "content-type": "text/event-stream" }, body: v2(frames) });
	});
	return bodies;
}

async function send(page: Page, text: string) {
	const input = page.locator("#user-input");
	await expect(input).toBeEnabled();
	await input.fill(text);
	await page.locator("#send-button").click();
}

test("the picker lists the tiers from /api/v1/models and sends the chosen one", async ({ page }) => {
	const bodies = await captureChat(page, [["token", { text: "ok" }], ["done", {}]]);
	await page.goto("/");

	const trigger = page.locator("#model-trigger");
	await expect(trigger).toHaveText("Fast");
	await trigger.click();
	const listbox = page.getByRole("listbox", { name: "Choose a model" });
	await expect(listbox).toBeFocused();
	// The owner-billed model's short name comes from the real listing.
	await expect(page.getByRole("option", { name: /Fast.*Llama 3\.1 8B/ })).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("option", { name: /Reasoning.*Sign in/ })).toBeVisible();
	await expect(page.getByRole("option", { name: /GPT-5\.5.*Sign in/ })).toBeVisible();

	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(page.locator("#model-popover")).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveText("Smart");

	await send(page, "hello");
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("ok");
	expect(bodies[0]?.model).toBe("smart");
});

test("Escape closes the picker without choosing, and focus returns to the trigger", async ({ page }) => {
	await page.goto("/");
	await page.locator("#model-trigger").click();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Escape");
	await expect(page.locator("#model-popover")).toBeHidden();
	await expect(page.locator("#model-trigger")).toBeFocused();
	await expect(page.locator("#model-trigger")).toHaveText("Fast");
});

test("a guest cannot pick a locked model", async ({ page }) => {
	const bodies = await captureChat(page, [["token", { text: "ok" }], ["done", {}]]);
	await page.goto("/");
	await page.locator("#model-trigger").click();
	await page.getByRole("option", { name: /Reasoning/ }).click();
	await expect(page.locator("#model-trigger")).toHaveText("Fast");
	// On production, where Clerk serves this origin, the locked row opened
	// the sign-in modal instead. Close it before chatting on.
	if (/eleenai\.xyz/.test(process.env.E2E_BASE_URL ?? "")) {
		await expect(page.locator(".cl-modalContent")).toBeVisible({ timeout: 30_000 });
		await page.keyboard.press("Escape");
		await expect(page.locator(".cl-modalContent")).toBeHidden();
	}
	await send(page, "hello");
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("ok");
	expect(bodies[0]?.model).toBe("fast");
});

test("the reasoning panel times the thinking and folds away when the answer starts", async ({ page }) => {
	await captureChat(page, [
		["meta", { model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", tier: "reasoning", protocol: 2 }],
		["reasoning", { text: "First, consider the question. " }],
		["reasoning", { text: "Then answer it." }],
		["token", { text: "**42**" }],
		["usage", { completionTokens: 12 }],
		["done", {}],
	]);
	await page.goto("/");
	await send(page, "what is the answer");

	const reply = page.locator(".assistant-message").last();
	const panel = reply.locator("details.reasoning");
	await expect(reply.locator("strong")).toHaveText("42");
	await expect(panel).not.toHaveAttribute("open");
	await expect(panel.locator(".reasoning-label")).toHaveText(/^Thought for \d+s$/);

	await panel.locator("summary").click();
	await expect(panel).toHaveAttribute("open", "");
	await expect(panel.locator(".reasoning-text")).toHaveText("First, consider the question. Then answer it.");

	// Copy takes the answer's markdown source, never the thinking.
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const copy = reply.locator(".copy-button");
	await copy.click();
	await expect(copy).toHaveClass(/is-done/);
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("**42**");
});

test("hostile reasoning text is shown, never run", async ({ page }) => {
	const dialogs: string[] = [];
	page.on("dialog", (d) => {
		dialogs.push(d.message());
		void d.dismiss();
	});
	await captureChat(page, [
		["reasoning", { text: '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>[x](javascript:alert(1))' }],
		["token", { text: "done" }],
		["done", {}],
	]);
	await page.goto("/");
	await send(page, "hi");

	const reply = page.locator(".assistant-message").last();
	await expect(reply.locator(".message-body p").last()).toHaveText("done");
	await expect(reply.locator("img, script, a[href^='javascript:' i]")).toHaveCount(0);
	await reply.locator(".reasoning summary").click();
	await expect(reply.locator(".reasoning-text")).toContainText("<script>");
	expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
	expect(dialogs).toEqual([]);
});

test("WebMCP's set_model still drives the modes inside the picker", async ({ page }) => {
	const bodies = await captureChat(page, [["token", { text: "ok" }], ["done", {}]]);
	await page.goto("/");
	// The tool clicks the hidden .mode-btn; the popover does not need to be open.
	await page.evaluate(() => {
		document.querySelector<HTMLButtonElement>('.mode-btn[data-mode="creative"]')?.click();
	});
	await send(page, "hello");
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("ok");
	expect(bodies[0]?.mode).toBe("creative");
});
