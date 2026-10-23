/**
 * M4.6 in a real browser: the consent dialog, the memory-and-privacy panel
 * and the privacy policy page.
 *
 * Signed-in state is faked by serving a stand-in for the Clerk SDK from
 * Clerk's own script URL, so the page's real auth code runs against it.
 * Every consent, memory and history route is mocked with page.route: the
 * backend for them is built separately, and nothing here touches a database.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

/** A stand-in for clerk-js: just the surface web/src/auth/clerk.ts uses. */
function fakeClerk(signedIn: boolean): string {
	const user = signedIn ? `{ id: "user_e2e", fullName: "Test User", imageUrl: null }` : "null";
	const session = signedIn ? `{ getToken: async () => "e2e-token" }` : "null";
	return `window.Clerk = {
		loaded: true,
		user: ${user},
		session: ${session},
		load: async () => {},
		addListener: () => () => {},
		openSignIn: () => {},
		openSignUp: () => {},
		signOut: async () => {},
	};`;
}

interface Api {
	requests: { method: string; path: string; body: unknown }[];
	consent: unknown;
	entries: { id: string; fact: string; createdAt: number }[];
}

async function mockApi(page: Page, { signedIn, consent = null }: { signedIn: boolean; consent?: unknown }): Promise<Api> {
	const api: Api = { requests: [], consent, entries: [] };
	await page.route("https://clerk.eleenai.xyz/**", (route) =>
		route.fulfill({ contentType: "application/javascript", body: fakeClerk(signedIn) }),
	);
	await page.route("**/api/v1/keys", (route) => route.fulfill({ json: { keys: [] } }));
	const record = (request: Request) => {
		const raw = request.postData();
		api.requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: raw ? JSON.parse(raw) : null });
	};
	await page.route("**/api/v1/consent", async (route) => {
		const request = route.request();
		record(request);
		if (request.method() === "PUT") {
			api.consent = { ...(JSON.parse(request.postData() ?? "{}") as object), policyVersion: 1, updatedAt: Date.now() };
		}
		await route.fulfill({ json: { consent: api.consent, policyVersion: 1 } });
	});
	await page.route(/\/api\/v1\/memory(\/[^/?]+)?$/, async (route) => {
		const request = route.request();
		record(request);
		if (request.method() === "GET") return route.fulfill({ json: { entries: api.entries } });
		const id = decodeURIComponent(new URL(request.url()).pathname.split("/")[4] ?? "");
		api.entries = id ? api.entries.filter((e) => e.id !== id) : [];
		return route.fulfill({ status: 204 });
	});
	// The sidebar (M4.4) reads the list and folders on every signed-in load;
	// only the writes are recorded here.
	await page.route("**/api/v1/conversations", async (route) => {
		if (route.request().method() === "GET") return route.fulfill({ json: { conversations: [], nextCursor: null } });
		record(route.request());
		await route.fulfill({ status: 204 });
	});
	await page.route("**/api/v1/folders", (route) => route.fulfill({ json: { folders: [] } }));
	return api;
}

const answered = { history: true, memory: true, policyVersion: 1, updatedAt: 1 };

test("a signed-in user who has not chosen is asked, and Save sends exactly their choices", async ({ page }) => {
	const api = await mockApi(page, { signedIn: true });
	await page.goto("/");

	const dialog = page.getByRole("dialog", { name: "Your conversations and memory" });
	await expect(dialog).toBeVisible();
	const history = dialog.getByRole("switch", { name: /Save my conversations/ });
	const memory = dialog.getByRole("switch", { name: /Remember facts about me/ });
	await expect(history).toBeChecked();
	await expect(memory).not.toBeChecked();
	await expect(history).toBeFocused();
	await expect(dialog.getByRole("link", { name: "Read the privacy policy" })).toHaveAttribute("href", "/privacy");

	// Keyboard only: Tab to the memory switch, Space turns it on.
	await page.keyboard.press("Tab");
	await expect(memory).toBeFocused();
	await page.keyboard.press("Space");
	await expect(memory).toBeChecked();

	await dialog.getByRole("button", { name: "Save my choices" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator(".toast.success")).toContainText("Your choices are saved.");
	expect(api.requests.filter((r) => r.method === "PUT")).toEqual([
		{ method: "PUT", path: "/api/v1/consent", body: { history: true, memory: true } },
	]);
	// Focus is not lost to <body>.
	expect(await page.evaluate(() => document.activeElement?.id)).toBe("user-input");
});

test("closing the consent dialog without choosing saves nothing", async ({ page }) => {
	const api = await mockApi(page, { signedIn: true });
	await page.goto("/");
	const dialog = page.getByRole("dialog", { name: "Your conversations and memory" });
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);
});

test("a guest is never asked and never sees the panel link", async ({ page }) => {
	const api = await mockApi(page, { signedIn: false });
	await page.goto("/");
	await expect(page.locator("#login-button")).toBeVisible();
	await page.locator("#model-trigger").click();
	await expect(page.locator("#model-popover")).toBeVisible();
	await expect(page.getByRole("button", { name: "Memory and privacy" })).toBeHidden();
	await page.waitForTimeout(500);
	await expect(page.locator("dialog")).toHaveCount(0);
	expect(api.requests).toEqual([]);
});

async function openPanel(page: Page) {
	await expect(page.locator("#logout-button")).toBeVisible();
	await page.locator("#model-trigger").click();
	await page.getByRole("button", { name: "Memory and privacy" }).click();
	const panel = page.getByRole("dialog", { name: "Memory and privacy" });
	await expect(panel).toBeVisible();
	await expect(page.locator("#model-popover")).toBeHidden();
	return panel;
}

test("the panel lists remembered facts and forgets one", async ({ page }) => {
	const api = await mockApi(page, { signedIn: true, consent: answered });
	api.entries = [
		{ id: "f1", fact: "Their name is Sam", createdAt: 1 },
		{ id: "f2", fact: "Prefers metric units", createdAt: 2 },
	];
	await page.goto("/");
	const panel = await openPanel(page);
	await expect(page.getByRole("dialog", { name: "Your conversations and memory" })).toHaveCount(0);

	const rows = panel.locator(".memory-row");
	await expect(rows).toHaveCount(2);
	await panel.getByRole("button", { name: "Forget: Their name is Sam" }).click();
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText("Prefers metric units");
	expect(api.requests.filter((r) => r.method === "DELETE")).toEqual([{ method: "DELETE", path: "/api/v1/memory/f1", body: null }]);

	// Escape closes it and focus goes back to the picker.
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
	await expect(page.locator("#model-trigger")).toBeFocused();
});

test("turning memory off warns first, then forgets", async ({ page }) => {
	const api = await mockApi(page, { signedIn: true, consent: answered });
	api.entries = [{ id: "f1", fact: "Lives in Dubai", createdAt: 1 }];
	await page.goto("/");
	const panel = await openPanel(page);
	await expect(panel.locator(".memory-row")).toHaveCount(1);

	await panel.getByRole("switch", { name: /Remember facts about me/ }).click();
	await expect(panel.getByText("Turning memory off also forgets everything")).toBeVisible();
	expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
	await panel.getByRole("button", { name: "Turn off and forget" }).click();
	await expect(panel.getByRole("switch", { name: /Remember facts about me/ })).not.toBeChecked();
	await expect(panel.locator(".memory-row")).toHaveCount(0);
	expect(api.requests.filter((r) => r.method === "PUT")).toEqual([
		{ method: "PUT", path: "/api/v1/consent", body: { history: true, memory: false } },
	]);
});

test("deleting all conversations takes an inline confirm", async ({ page }) => {
	const api = await mockApi(page, { signedIn: true, consent: answered });
	await page.goto("/");
	const panel = await openPanel(page);
	await expect(panel.getByText("Nothing remembered yet")).toBeVisible();

	await panel.getByRole("button", { name: "Delete all my conversations" }).click();
	await expect(panel.getByRole("button", { name: "Cancel" })).toBeFocused();
	await panel.getByRole("button", { name: "Cancel" }).click();
	expect(api.requests.some((r) => r.path === "/api/v1/conversations")).toBe(false);

	await panel.getByRole("button", { name: "Delete all my conversations" }).click();
	await panel.getByRole("button", { name: "Yes, delete them all" }).click();
	await expect(panel.getByText("All your saved conversations are deleted.")).toBeVisible();
	expect(api.requests.filter((r) => r.path === "/api/v1/conversations")).toEqual([
		{ method: "DELETE", path: "/api/v1/conversations", body: null },
	]);
});

test("the privacy page is linked from the footer and needs no script", async ({ page }) => {
	await mockApi(page, { signedIn: false });
	await page.goto("/");
	await page.locator("footer").getByRole("link", { name: "Privacy" }).click();
	await expect(page).toHaveURL(/\/privacy$/);
	await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
	await expect(page.locator("section#ar[dir='rtl'][lang='ar'] h1")).toHaveText("سياسة الخصوصية");
	for (const words of ["Cloudflare D1", "Voice recordings", "Spoken replies", "stays in your browser tab", "encrypted"]) {
		await expect(page.locator("section#en")).toContainText(words);
	}
	// None of ours. On production the zone injects its two scripts (JavaScript
	// Detections and the Web Analytics beacon), each with the document's nonce,
	// and the Detections loader sometimes adds its own same-origin
	// /cdn-cgi/challenge-platform/ script without one. None of those are ours.
	expect(await page.locator('script:not([nonce]):not([src^="/cdn-cgi/"])').count()).toBe(0);
	// The site stylesheet applied: the heading takes the token colour, not
	// the browser's default black. After the click the URL commits before
	// the stylesheet lands, so wait for the load (it flaked on production).
	await page.waitForLoadState("load");
	const heading = await page.locator("section#en h1").evaluate((h) => getComputedStyle(h).color);
	expect(heading).not.toBe("rgb(0, 0, 0)");
	await expect.poll(() => page.locator(".policy-top img").evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
