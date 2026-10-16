/**
 * The scene fallback (DESIGN.md section 8): a still poster on first paint,
 * the 2.3 MB live viewer only where the device can afford it.
 */
import { expect, test, type Page } from "@playwright/test";

function watchViewer(page: Page) {
	const requested: string[] = [];
	page.on("request", (r) => {
		if (r.url().includes("@splinetool/viewer")) requested.push(r.url());
	});
	return requested;
}

test("shows the poster at once", async ({ page }) => {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	const poster = page.locator("#scene-poster");
	await expect(poster).toBeVisible();
	await expect.poll(() => poster.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
});

test.describe("with reduced motion", () => {
	test.use({ reducedMotion: "reduce" });

	test("never fetches the viewer, and keeps the poster and scrim", async ({ page }) => {
		const requested = watchViewer(page);
		await page.goto("/");
		await page.waitForTimeout(1500);
		expect(requested).toEqual([]);
		await expect(page.locator("#spline-bg")).toHaveAttribute("data-skip", "reduced-motion");
		await expect(page.locator("spline-viewer")).toHaveCount(0);
		await expect(page.locator("#scene-poster")).toBeVisible();
		await expect(page.locator("#chat-scrim")).toBeAttached();
		await expect(page.locator("#spline-loader")).toBeHidden();
	});
});

test.describe("on a touch device", () => {
	test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

	test("never fetches the viewer", async ({ page }) => {
		const requested = watchViewer(page);
		await page.goto("/");
		await page.waitForTimeout(1500);
		expect(requested).toEqual([]);
		await expect(page.locator("#spline-bg")).toHaveAttribute("data-skip", "coarse-pointer");
	});
});

test("on a desktop fetches the viewer, once, after the app has started", async ({ page }) => {
	const requested = watchViewer(page);
	await page.goto("/");
	await expect(page.locator("#spline-bg")).toHaveAttribute("data-mode", "live");
	await expect.poll(() => requested.length).toBe(1);
	expect(requested[0]).toContain("@splinetool/viewer@1.12.88/");
});
