/**
 * Theming (M4.5): dark and light, left-to-right and right-to-left, and the
 * two header toggles that choose between them.
 *
 * The four-combination run saves a full-page screenshot of each to
 * test-results/theme/ for review (DESIGN.md principle 5). Those images are
 * for a person to look at, not baselines: the scene behind the page moves,
 * so pixel comparison would only measure the robot. The assertions check
 * what can be checked as values. Model calls are intercepted, so nothing
 * here costs inference.
 */
import { expect, test, type Page } from "@playwright/test";

const v2 = (frames: [string, unknown][]) =>
	frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const REPLY = [
	"## Strong passwords",
	"",
	"A strong password is **long**, unique, and hard to guess. See [the guidance](https://example.com/guide).",
	"",
	"> [!TIP]",
	"> A passphrase of four random words beats a short jumble of symbols.",
	"",
	"```python",
	"def is_strong(password: str) -> bool:",
	"    # Length matters most.",
	'    return len(password) >= 12 and not password.isalpha()',
	"```",
	"",
	"[SUGGEST]How do password managers work?[/SUGGEST]",
	"[SUGGEST]What is two-factor authentication?[/SUGGEST]",
].join("\n");

async function mockChat(page: Page) {
	await page.route("**/api/chat/guest", (route) =>
		route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([
				["meta", { model: "@cf/meta/llama-3.1-8b-instruct-fp8", tier: "fast", protocol: 2 }],
				["token", { text: REPLY }],
				["usage", { promptTokens: 12, completionTokens: 96 }],
				["done", {}],
			]),
		}),
	);
}

/** Seed the stored choices before any page script runs, as a returning visitor. */
async function seed(page: Page, prefs: { theme?: string; lang?: string }) {
	await page.addInitScript((p) => {
		// Only on the first document: a reload must read what the page stored.
		if (sessionStorage.getItem("seeded")) return;
		sessionStorage.setItem("seeded", "1");
		if (p.theme) localStorage.setItem("eleen.theme", p.theme);
		if (p.lang) localStorage.setItem("eleen.lang", p.lang);
	}, prefs);
}

/** Record <html>'s theme, lang and dir at the moment <body> is parsed: before first paint. */
async function recordFirstPaintState(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as { __atBody?: { theme?: string; lang: string; dir: string } };
		new MutationObserver((_, observer) => {
			if (!document.body) return;
			const root = document.documentElement;
			w.__atBody = { theme: root.dataset.theme, lang: root.lang, dir: root.dir };
			observer.disconnect();
		}).observe(document, { childList: true, subtree: true });
	});
}

const cssVar = (page: Page, name: string) =>
	page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

// Reduced motion: the poster stands in for the live scene and entrances are
// instant, so each screenshot shows the settled page.
test.use({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });

for (const theme of ["dark", "light"] as const) {
	for (const dir of ["ltr", "rtl"] as const) {
		test(`${theme} ${dir}: tokens, direction and layout, with a screenshot`, async ({ page }) => {
			const lang = dir === "rtl" ? "ar" : "en";
			await recordFirstPaintState(page);
			await seed(page, { theme, lang });
			await mockChat(page);
			await page.goto("/");

			// Applied before the body existed, so the first paint was already right.
			const atBody = await page.evaluate(() => (window as unknown as { __atBody?: unknown }).__atBody);
			expect(atBody).toEqual({ theme, lang, dir });

			const html = page.locator("html");
			await expect(html).toHaveAttribute("data-theme", theme);
			await expect(html).toHaveAttribute("dir", dir);
			await expect(html).toHaveAttribute("lang", lang);
			expect(await cssVar(page, "--text")).toBe(theme === "dark" ? "#e8e8ff" : "#16163a");
			const colorScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
			expect(colorScheme).toBe(theme);

			// The toggles show the state they are in.
			await expect(page.locator("#theme-toggle")).toHaveAttribute("data-pref", theme);
			await expect(page.locator("#lang-toggle .lang-toggle-text")).toHaveText(dir === "rtl" ? "English" : "العربية");
			// Static text from the HTML follows the language.
			await expect(page.locator("footer p")).toContainText(dir === "rtl" ? "بدعم من" : "Powered by");

			const input = page.locator("#user-input");
			await expect(input).toBeEnabled();
			await input.fill(dir === "rtl" ? "كيف أختار كلمة مرور قوية؟" : "How do I choose a strong password?");
			await page.locator("#send-button").click();
			const reply = page.locator(".assistant-message").last();
			await expect(reply.locator(".suggestion-chip")).toHaveCount(2);
			await expect(reply.locator(".code-block")).toBeVisible();

			// Logical properties: the user bubble sits at the inline-end of the
			// column and the assistant panel at its inline-start, mirrored as a whole.
			const column = await page.locator("#chat-messages").boundingBox();
			const user = await page.locator(".user-message").last().boundingBox();
			const assistant = await reply.boundingBox();
			if (!column || !user || !assistant) throw new Error("missing layout boxes");
			const columnEnd = dir === "ltr" ? column.x + column.width : column.x;
			const userEnd = dir === "ltr" ? user.x + user.width : user.x;
			const assistantStart = dir === "ltr" ? assistant.x : assistant.x + assistant.width;
			const columnStart = dir === "ltr" ? column.x : column.x + column.width;
			expect(Math.abs(columnEnd - userEnd)).toBeLessThan(40);
			expect(Math.abs(columnStart - assistantStart)).toBeLessThan(40);

			// Bubbles pick their own direction; code always reads left to right.
			await expect(page.locator(".user-message > p").last()).toHaveAttribute("dir", "auto");
			await expect(reply.locator(".message-body").first()).toHaveAttribute("dir", "auto");
			expect(await reply.locator("pre").first().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");

			// The toggles open the auth plate, on its inline-start side; with a
			// conversation on screen, the Export button (M5.3) comes just before them.
			const exporter = await page.locator(".export-control").boundingBox();
			const prefs = await page.locator(".prefs").boundingBox();
			const plate = await page.locator(".auth-container").boundingBox();
			if (!exporter || !prefs || !plate) throw new Error("missing toggle boxes");
			const plateStart = dir === "ltr" ? plate.x : plate.x + plate.width;
			const exportStart = dir === "ltr" ? exporter.x : exporter.x + exporter.width;
			const exportEnd = dir === "ltr" ? exporter.x + exporter.width : exporter.x;
			const prefsStart = dir === "ltr" ? prefs.x : prefs.x + prefs.width;
			expect(Math.abs(plateStart - exportStart)).toBeLessThan(16);
			expect(Math.abs(exportEnd - prefsStart)).toBeLessThan(16);

			// Playwright empties test-results/ at the start of each run, so these are always the latest.
			await page.screenshot({ path: `test-results/theme/${theme}-${dir}.png`, fullPage: true });
		});
	}
}

for (const dir of ["ltr", "rtl"] as const) {
	test(`${dir} on a phone: the toggles fit beside the sign-in pair`, async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 760 });
		await seed(page, { theme: "light", lang: dir === "rtl" ? "ar" : "en" });
		await page.goto("/");
		await expect(page.locator("#user-input")).toBeEnabled();
		const plate = await page.locator(".auth-container").boundingBox();
		if (!plate) throw new Error("no auth plate");
		expect(plate.x).toBeGreaterThanOrEqual(0);
		expect(plate.x + plate.width).toBeLessThanOrEqual(360);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
		// The language name is visually hidden here but still names the button.
		await expect(page.locator("#lang-toggle")).toHaveAccessibleName(dir === "rtl" ? "English" : "العربية");
		await page.screenshot({ path: `test-results/theme/phone-light-${dir}.png` });

		// With a conversation the Export button (M5.3) joins the plate, which still fits.
		await mockChat(page);
		await page.locator("#user-input").fill("Hi");
		await page.locator("#send-button").click();
		await expect(page.locator("#export-button")).toBeVisible();
		const withExport = await page.locator(".auth-container").boundingBox();
		if (!withExport) throw new Error("no auth plate");
		expect(withExport.x).toBeGreaterThanOrEqual(0);
		expect(withExport.x + withExport.width).toBeLessThanOrEqual(360);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
		await page.locator(".auth-container").screenshot({ path: `test-results/theme/phone-light-${dir}-export.png` });
	});
}

test("the theme toggle cycles system, light, dark, and the choice survives a reload", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/");
	const toggle = page.locator("#theme-toggle");
	const html = page.locator("html");

	// No stored choice: follow the system, live.
	await expect(toggle).toHaveAttribute("data-pref", "system");
	await expect(toggle).toHaveAccessibleName("Theme: match system");
	await expect(html).toHaveAttribute("data-theme", "dark");
	await page.emulateMedia({ colorScheme: "light" });
	await expect(html).toHaveAttribute("data-theme", "light");

	await toggle.click();
	await expect(toggle).toHaveAttribute("data-pref", "light");
	await expect(toggle).toHaveAccessibleName("Theme: light");
	await expect(html).toHaveAttribute("data-theme", "light");

	await toggle.click();
	await expect(toggle).toHaveAttribute("data-pref", "dark");
	await expect(html).toHaveAttribute("data-theme", "dark");
	// A fixed choice ignores the system.
	await page.emulateMedia({ colorScheme: "light" });
	await expect(html).toHaveAttribute("data-theme", "dark");

	await page.reload();
	await expect(page.locator("#theme-toggle")).toHaveAttribute("data-pref", "dark");
	await expect(html).toHaveAttribute("data-theme", "dark");

	await page.locator("#theme-toggle").click();
	await expect(page.locator("#theme-toggle")).toHaveAttribute("data-pref", "system");
	expect(await page.evaluate(() => localStorage.getItem("eleen.theme"))).toBeNull();
});

test("the language toggle switches to Arabic and right-to-left, and back, across reloads", async ({ page }) => {
	await page.goto("/");
	const html = page.locator("html");
	const toggle = page.locator("#lang-toggle");
	await expect(html).toHaveAttribute("dir", "ltr");
	await expect(toggle).toHaveAccessibleName("العربية");

	await Promise.all([page.waitForEvent("load"), toggle.click()]);
	await expect(html).toHaveAttribute("lang", "ar");
	await expect(html).toHaveAttribute("dir", "rtl");
	await expect(page.locator("#lang-toggle")).toHaveAccessibleName("English");
	// Strings that came from t() at boot are Arabic now.
	await expect(page.locator("#send-button span")).toHaveText("إرسال");
	await expect(page.locator(".empty-ask")).toHaveText("كيف يمكنني مساعدتك اليوم؟");

	await page.reload();
	await expect(html).toHaveAttribute("dir", "rtl");

	await Promise.all([page.waitForEvent("load"), page.locator("#lang-toggle").click()]);
	await expect(html).toHaveAttribute("dir", "ltr");
	await expect(page.locator("#send-button span")).toHaveText("Send");
});

test("switching language mid-conversation asks first, and stays on no", async ({ page }) => {
	await mockChat(page);
	await page.goto("/");
	const input = page.locator("#user-input");
	await expect(input).toBeEnabled();
	await input.fill("hello");
	await page.locator("#send-button").click();
	await expect(page.locator(".assistant-message .suggestion-chip")).toHaveCount(2);

	let asked = "";
	page.once("dialog", (dialog) => {
		asked = dialog.message();
		void dialog.dismiss();
	});
	await page.locator("#lang-toggle").click();
	await expect.poll(() => asked).toContain("clears this conversation");
	await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
	await expect(page.locator(".user-message")).toHaveCount(1);
});

test("the page works with storage blocked", async ({ page }) => {
	await page.addInitScript(() => {
		const blocked = () => {
			throw new DOMException("blocked", "SecurityError");
		};
		Storage.prototype.getItem = blocked;
		Storage.prototype.setItem = blocked;
		Storage.prototype.removeItem = blocked;
	});
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await expect(page.locator("#user-input")).toBeEnabled();
	await page.locator("#theme-toggle").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await page.locator("#theme-toggle").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	expect(errors.filter((m) => /eleen|prefs|theme/i.test(m))).toEqual([]);
});
