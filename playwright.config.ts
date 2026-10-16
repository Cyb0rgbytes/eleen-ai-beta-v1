/**
 * End-to-end tests against the real page in a real browser.
 *
 * Default target is a local `wrangler dev`, started here if one is not
 * already listening. Set E2E_BASE_URL=https://eleenai.xyz to run the same
 * suite against production; the server step is then skipped.
 *
 * Nothing in e2e/ sends a real chat message: model calls are intercepted
 * with crafted responses, so a run costs no inference on either target.
 */
import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787";
const isLocal = /127\.0\.0\.1|localhost/.test(baseURL);

export default defineConfig({
	testDir: "./e2e",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	retries: process.env.CI ? 1 : 0,
	reporter: [["list"]],
	use: {
		baseURL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				browserName: "chromium",
				// Hardware WebGL where the machine has a GPU, as visitors do. In
				// software WebGL the live scene froze the main thread for about
				// 20 s on production (measured 2026-10-17), which timed out tests
				// that have nothing to do with the scene. Without a GPU, Chromium
				// falls back to software as before.
				launchOptions: { args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] },
			},
		},
	],
	webServer: isLocal
		? {
				command: "npx wrangler dev --port 8787",
				url: `${baseURL}/api/v1/health`,
				reuseExistingServer: true,
				timeout: 120_000,
			}
		: undefined,
});
