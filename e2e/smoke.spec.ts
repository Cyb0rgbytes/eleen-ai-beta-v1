/**
 * Does the page come up usable, and do the inference-free endpoints answer?
 * No model is called. Auth assertions run only against production, where
 * the Clerk production instance accepts the origin.
 */
import { expect, test } from "@playwright/test";

const isProduction = /eleenai\.xyz/.test(process.env.E2E_BASE_URL ?? "");

test.describe("page", () => {
	test("loads with the composer enabled, whatever auth did", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveTitle(/Eleen/);

		// updateAuthUI() runs in a finally and is the only code that enables
		// these. If this fails, the 6778bb2 regression is back.
		const input = page.locator("#user-input");
		const send = page.locator("#send-button");
		await expect(input).toBeEnabled();
		await expect(send).toBeEnabled();
		await expect(page.locator("#mic-button")).toBeVisible();
	});

	test("carries the security headers", async ({ request }) => {
		const response = await request.get("/");
		expect(response.status()).toBe(200);
		expect(response.headers()["content-type"]).toMatch(/charset=utf-8/i);
		expect(response.headers()["x-frame-options"]).toBe("DENY");
		expect(response.headers()["x-content-type-options"]).toBe("nosniff");
		expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
		expect(response.headers()["content-security-policy-report-only"]).toBe("require-trusted-types-for 'script'");
	});

	test("has a tab icon, and /favicon.ico points at it", async ({ page, request }) => {
		await page.goto("/");
		const href = await page.locator('link[rel="icon"]').first().getAttribute("href");
		expect(href).toBe("/favicon-32.png");
		const icon = await request.get(href!);
		expect(icon.status()).toBe(200);
		expect(icon.headers()["content-type"]).toContain("image/png");
		const legacy = await request.get("/favicon.ico", { maxRedirects: 0 });
		expect(legacy.status()).toBe(301);
		expect(legacy.headers()["location"]).toBe("/favicon-32.png");
	});

	test("opens the sign-in modal from the Login control", async ({ page }) => {
		test.skip(!isProduction, "Clerk's production instance only serves the production origin");
		await page.goto("/");
		await page.locator("#login-button").click();
		await expect(page.locator(".cl-modalContent")).toBeVisible();
		await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
	});
});

test.describe("inference-free API", () => {
	test("health answers", async ({ request }) => {
		const response = await request.get("/api/v1/health");
		expect(response.ok()).toBe(true);
		const body = (await response.json()) as { status: string; capabilities: string[] };
		expect(body.status).toBe("ok");
		expect(body.capabilities).toContain("chat");
	});

	test("models lists every tier with an access requirement", async ({ request }) => {
		const response = await request.get("/api/v1/models");
		expect(response.ok()).toBe(true);
		const body = (await response.json()) as {
			default: string;
			models: { tier: string; access: string }[];
		};
		expect(body.default).toBeTruthy();
		for (const tier of ["fast", "smart", "reasoning"]) {
			expect(body.models.some((m) => m.tier === tier), tier).toBe(true);
		}
		expect(body.models.every((m) => ["guest", "sign-in", "key-required"].includes(m.access))).toBe(true);
	});

	test("keys requires sign-in", async ({ request }) => {
		const response = await request.get("/api/v1/keys");
		expect(response.status()).toBe(401);
	});
});
