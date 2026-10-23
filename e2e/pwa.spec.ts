/**
 * M5.5 in a real browser: the web app manifest, the service worker, the
 * offline fallback, and the scene after the viewer deferral.
 *
 * The worker registers only on production-like origins; on 127.0.0.1 the
 * page is told to register it anyway through localStorage "eleen.sw".
 */
import { expect, test, type Page } from "@playwright/test";

async function enableServiceWorker(page: Page) {
	await page.addInitScript(() => localStorage.setItem("eleen.sw", "1"));
}

/** Wait until the worker controls the page (after its first install, one reload). */
async function controlled(page: Page) {
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
		await page.reload();
		await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
	}
}

test("the manifest is served as JSON, with the security headers, and is linked from the page", async ({ page, request }) => {
	const response = await request.get("/manifest.webmanifest");
	expect(response.status()).toBe(200);
	expect(response.headers()["content-type"]).toContain("application/manifest+json");
	expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
	expect(response.headers()["x-content-type-options"]).toBe("nosniff");
	const manifest = await response.json();
	expect(manifest).toMatchObject({ name: "EleenAI", short_name: "EleenAI", start_url: "/", display: "standalone" });
	expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
	expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
	const sizes = manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`);
	expect(sizes).toEqual(expect.arrayContaining(["192x192 any", "512x512 any", "512x512 maskable"]));
	for (const icon of manifest.icons as { src: string; type: string }[]) {
		const file = await request.get(icon.src);
		expect(file.status(), icon.src).toBe(200);
		expect(file.headers()["content-type"]).toBe(icon.type);
	}

	await page.goto("/");
	await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");

	const sw = await request.get("/sw.js");
	expect(sw.status()).toBe(200);
	expect(sw.headers()["content-type"]).toContain("javascript");
	expect(sw.headers()["cache-control"]).toBe("no-cache");
	const source = await sw.text();
	expect(source).not.toContain("__SW_VERSION__");
	expect(source).toMatch(/\/assets\/index-[\w-]+\.js/);
});

test("on localhost the worker is not registered unless asked", async ({ page }) => {
	test.skip(/eleenai\.xyz/.test(process.env.E2E_BASE_URL ?? ""), "on production the worker is meant to register");
	await page.goto("/");
	await page.waitForLoadState("load");
	await page.waitForTimeout(500);
	expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length))).toBe(0);
});

test("on production the worker registers by itself", async ({ page }) => {
	test.skip(!/eleenai\.xyz/.test(process.env.E2E_BASE_URL ?? ""), "only production-like origins register it unasked");
	await page.goto("/");
	await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
	const scope = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.scope ?? null));
	expect(scope).toBe(new URL("/", page.url()).href);
});

test("the worker registers, serves the build from its cache, and never answers /api", async ({ page }) => {
	await enableServiceWorker(page);
	await page.goto("/");
	await controlled(page);

	const state = await page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		const keys = await caches.keys();
		const cache = await caches.open(keys.find((k) => k.startsWith("eleenai-")) ?? "none");
		const cached = (await cache.keys()).map((r) => new URL(r.url).pathname);
		return { scope: registration?.scope, active: registration?.active?.state, keys, cached };
	});
	expect(state.scope).toMatch(/\/$/);
	expect(state.active).toBe("activated");
	expect(state.keys.filter((k) => k.startsWith("eleenai-"))).toHaveLength(1);
	expect(state.cached).toContain("/offline");
	expect(state.cached.some((p) => /^\/assets\/index-[\w-]+\.js$/.test(p))).toBe(true);
	// Only hashed build output and the offline page are precached.
	expect(state.cached.every((p) => p === "/offline" || /^\/(assets|fonts)\//.test(p))).toBe(true);

	// /api is never answered by the worker, nor cached.
	const api = page.waitForResponse((r) => r.url().endsWith("/api/v1/health"));
	await page.evaluate(() => fetch("/api/v1/health").then((r) => r.status));
	expect((await api).fromServiceWorker()).toBe(false);
	const apiCached = await page.evaluate(async () => {
		for (const key of await caches.keys()) {
			const cache = await caches.open(key);
			if ((await cache.keys()).some((r) => new URL(r.url).pathname.startsWith("/api/"))) return true;
		}
		return false;
	});
	expect(apiCached).toBe(false);

	// The app bundle, on a reload, comes from the worker.
	const bundle = page.waitForResponse((r) => /\/assets\/index-[\w-]+\.js$/.test(r.url()));
	await page.reload();
	expect((await bundle).fromServiceWorker()).toBe(true);
	await expect(page.locator("#user-input")).toBeEnabled();
});

test("offline, a navigation shows the offline page, and online again the app comes back", async ({ page, context }) => {
	await enableServiceWorker(page);
	await page.goto("/");
	await controlled(page);

	await context.setOffline(true);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
	await expect(page.locator('section[lang="ar"] h2')).toHaveText("أنت غير متصل بالإنترنت");
	await page.goto("/privacy");
	await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();

	await context.setOffline(false);
	await page.getByRole("link", { name: /Try again/ }).click();
	await expect(page.locator("#user-input")).toBeEnabled();
	await expect(page.locator(".logo-image")).toBeVisible();
});

test("the scene still loads, after the page is idle", async ({ page }) => {
	const requested: { url: string; at: number }[] = [];
	page.on("request", (r) => {
		if (r.url().includes("@splinetool/viewer")) requested.push({ url: r.url(), at: Date.now() });
	});
	await page.goto("/");
	const loadedAt = await page.evaluate(() => performance.timing.loadEventEnd);
	await expect(page.locator("#spline-bg")).toHaveAttribute("data-mode", "live");
	await expect.poll(() => requested.length).toBe(1);
	// Not before the load event: the viewer never competes with first paint.
	expect(loadedAt).toBeGreaterThan(0);
	expect(requested[0]?.at ?? 0).toBeGreaterThanOrEqual(loadedAt);
	await expect(page.locator("#scene-poster")).toBeVisible();
});
