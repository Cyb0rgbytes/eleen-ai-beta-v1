#!/usr/bin/env node
/**
 * Capture the still poster of the 3D scene (DESIGN.md section 8).
 *
 * Loads production, hides everything but the scene, removes the viewer's
 * own "Built with Spline" overlay so it is not baked into the image, and
 * writes web/public/scene-poster.webp. Re-run when the scene changes.
 *
 *   node scripts/capture-poster.mjs
 *
 * Uses sharp, which is already installed as a dependency of the test
 * runtime; it is a one-off developer script, not part of the build.
 */
import { chromium } from "@playwright/test";
import sharp from "sharp";

const OUT = "web/public/scene-poster.webp";
const WIDTH = 1920;
const HEIGHT = 1080;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.goto("https://eleenai.xyz/", { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("#spline-bg")?.classList.contains("loaded"), null, { timeout: 60_000 });
// Let the robot settle into its idle pose.
await page.waitForTimeout(4000);

await page.addStyleTag({
	content: `
		body > :not(#spline-bg) { visibility: hidden !important; }
		#spline-bg::before { display: none !important; }
	`,
});
await page.evaluate(() => {
	const viewer = document.querySelector("spline-viewer");
	viewer?.shadowRoot?.querySelectorAll("#logo, a[href*='spline.design']").forEach((el) => el.remove());
});
// Park the cursor off-centre so the robot looks toward the conversation.
await page.mouse.move(WIDTH * 0.5, HEIGHT * 0.35);
await page.waitForTimeout(1200);

const png = await page.screenshot({ type: "png" });
await browser.close();

const info = await sharp(png).webp({ quality: 72, effort: 6 }).toFile(OUT);
console.log(`Wrote ${OUT}: ${info.width}x${info.height}, ${(info.size / 1024).toFixed(1)} KB`);
