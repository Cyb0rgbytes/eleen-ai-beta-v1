/**
 * M5.2 in a real browser: attaching files in the composer (button, drop,
 * paste), a chip per file with upload progress and remove, the ids sent with
 * the turn, chips on the sent and the reopened turn, errors as toasts, and
 * the sign-in prompt for guests.
 *
 * Signed-in state is faked with a stand-in for the Clerk SDK served from
 * Clerk's own script URL (as in consent.spec.ts); the file, chat and history
 * routes are all mocked, so nothing reaches R2, a model or a database.
 */
import { expect, test, type Page } from "@playwright/test";

const v2 = (frames: [string, unknown][]) =>
	frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

function fakeClerk(signedIn: boolean): string {
	const user = signedIn ? `{ id: "user_e2e", fullName: "Test User", imageUrl: null }` : "null";
	const session = signedIn ? `{ getToken: async () => "e2e-token" }` : "null";
	return `window.Clerk = {
		loaded: true,
		user: ${user},
		session: ${session},
		load: async () => {},
		addListener: () => () => {},
		openSignIn: () => { window.__signInOpened = true; },
		openSignUp: () => {},
		signOut: async () => {},
	};`;
}

type Body = Record<string, unknown>;

interface Mock {
	uploads: { name: string | null; auth: string | null; size: number }[];
	deletes: string[];
	chats: Body[];
	detail: unknown;
	/** What the next upload answers: a status and body. */
	next: { status: number; body: unknown } | null;
}

const FILE_ID = "11111111-1111-4111-8111-111111111111";

async function mock(page: Page, { signedIn = true, history = true }: { signedIn?: boolean; history?: boolean } = {}): Promise<Mock> {
	const m: Mock = { uploads: [], deletes: [], chats: [], detail: null, next: null };
	await page.route("https://clerk.eleenai.xyz/**", (route) =>
		route.fulfill({ contentType: "application/javascript", body: fakeClerk(signedIn) }),
	);
	await page.route("**/api/v1/keys", (route) => route.fulfill({ json: { keys: [] } }));
	await page.route("**/api/v1/consent", (route) =>
		route.fulfill({ json: { consent: { history, memory: false, policyVersion: 1, updatedAt: 1 }, policyVersion: 1 } }),
	);
	await page.route("**/api/v1/folders**", (route) => route.fulfill({ json: { folders: [] } }));
	await page.route(/\/api\/v1\/conversations(\/[^?]*)?(\?.*)?$/, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET" && path === "/api/v1/conversations") {
			return route.fulfill({ json: { conversations: [], nextCursor: null } });
		}
		if (request.method() === "GET") return route.fulfill({ json: m.detail });
		return route.fulfill({ json: { conversation: { id: "c1", title: "Saved", pinned: false, folderId: null, createdAt: 1, updatedAt: 2 } } });
	});
	let uploadCount = 0;
	await page.route("**/api/v1/files", async (route) => {
		const request = route.request();
		const name = request.headers()["x-file-name"] ?? null;
		m.uploads.push({ name: name && decodeURIComponent(name), auth: request.headers()["authorization"] ?? null, size: request.postDataBuffer()?.length ?? 0 });
		if (m.next) {
			const { status, body } = m.next;
			m.next = null;
			return route.fulfill({ status, json: body });
		}
		uploadCount++;
		const id = uploadCount === 1 ? FILE_ID : `2222222${uploadCount}-2222-4222-8222-222222222222`;
		return route.fulfill({
			status: 201,
			json: { file: { id, name: decodeURIComponent(name ?? "file"), type: "text/plain", size: request.postDataBuffer()?.length ?? 0, kind: "document", chars: 10 } },
		});
	});
	await page.route(/\/api\/v1\/files\/[^/]+$/, async (route) => {
		m.deletes.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/")[4] ?? ""));
		return route.fulfill({ status: 204 });
	});
	let turn = 0;
	await page.route("**/api/chat", async (route) => {
		const body = JSON.parse(route.request().postData() ?? "{}") as Body;
		m.chats.push(body);
		turn++;
		await route.fulfill({
			headers: { "content-type": "text/event-stream" },
			body: v2([
				["meta", { model: "m", protocol: 2, conversationId: "c1", userMessageId: `u${turn}`, assistantMessageId: `a${turn}` }],
				["token", { text: `Reply ${turn}` }],
				["done", {}],
			]),
		});
	});
	return m;
}

async function open(page: Page, signedIn = true) {
	const consent = signedIn ? page.waitForResponse((r) => r.url().includes("/api/v1/consent")) : null;
	await page.goto("/");
	await consent;
	if (signedIn) await expect(page.locator("#logout-button")).toBeVisible();
	await page.waitForTimeout(150);
	await expect(page.locator("#user-input")).toBeEnabled();
}

const textFile = (name: string, text = "hello world") => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });

test("a guest who presses attach is asked to sign in, and nothing uploads", async ({ page }) => {
	const m = await mock(page, { signedIn: false });
	await open(page, false);
	const attach = page.locator("#attach-button");
	await expect(attach).toBeVisible();
	await expect(attach).toHaveAccessibleName("Attach files");
	await attach.click();
	const toast = page.locator(".toast").filter({ hasText: "Sign in to attach files." });
	await expect(toast).toBeVisible();
	await toast.locator(".toast-action").click();
	expect(await page.evaluate(() => (window as unknown as { __signInOpened?: boolean }).__signInOpened)).toBe(true);
	expect(m.uploads).toHaveLength(0);
});

test("an attached file uploads with the session token, shows a chip, and its id goes with the turn", async ({ page }) => {
	const m = await mock(page);
	await open(page);

	await page.locator("#attach-input").setInputFiles(textFile("notes.txt", "Quarterly numbers"));
	const chip = page.locator(".file-tray .file-chip");
	await expect(chip).toHaveAttribute("data-state", "ready");
	await expect(chip.locator(".file-chip-name")).toHaveText("notes.txt");
	await expect(chip.locator(".file-chip-meta")).toHaveText("1 KB");
	expect(m.uploads).toEqual([{ name: "notes.txt", auth: "Bearer e2e-token", size: 17 }]);

	await page.locator("#user-input").fill("Summarise this");
	await page.locator("#send-button").click();
	await expect(page.locator('.assistant-message[data-message-id="a1"]')).toContainText("Reply 1");

	expect(m.chats[0]).toMatchObject({ files: [FILE_ID], messages: [{ role: "user", content: "Summarise this" }], parentId: null });
	// The tray empties and the chip moves onto the sent turn.
	await expect(page.locator(".file-tray")).toBeHidden();
	const sent = page.locator('.user-turn[data-message-id="u1"] .user-message .file-chip');
	await expect(sent).toHaveText(/notes\.txt/);
	await expect(sent.locator(".file-chip-remove")).toHaveCount(0);

	// The next turn carries no files of its own.
	await page.locator("#user-input").fill("And then?");
	await page.locator("#send-button").click();
	await expect(page.locator('.assistant-message[data-message-id="a2"]')).toContainText("Reply 2");
	expect(m.chats[1]).not.toHaveProperty("files");
});

test("sending with only a file uses a default prompt", async ({ page }) => {
	const m = await mock(page);
	await open(page);
	await page.locator("#attach-input").setInputFiles(textFile("a.txt"));
	await expect(page.locator(".file-tray .file-chip")).toHaveAttribute("data-state", "ready");
	await page.locator("#user-input").press("Enter");
	await expect(page.locator('.assistant-message[data-message-id="a1"]')).toBeVisible();
	expect(m.chats[0]).toMatchObject({ files: [FILE_ID], messages: [{ role: "user", content: "Please take a look at the attached file." }] });
});

test("removing a chip before sending deletes the stored file", async ({ page }) => {
	const m = await mock(page);
	await open(page);
	await page.locator("#attach-input").setInputFiles(textFile("draft.txt"));
	const chip = page.locator(".file-tray .file-chip");
	await expect(chip).toHaveAttribute("data-state", "ready");
	await chip.getByRole("button", { name: "Remove draft.txt" }).click();
	await expect(chip).toHaveCount(0);
	await expect.poll(() => m.deletes).toEqual([FILE_ID]);
});

test("a refused upload is a toast and leaves no chip", async ({ page }) => {
	const m = await mock(page);
	await open(page);
	m.next = { status: 415, body: { error: "nope", reason: "unsupported-type" } };
	await page.locator("#attach-input").setInputFiles({ name: "tool.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
	await expect(page.locator(".toast.error")).toContainText("That file type is not supported.");
	await expect(page.locator(".file-tray .file-chip")).toHaveCount(0);
});

test("a file over 10 MB is refused before it uploads", async ({ page }) => {
	const m = await mock(page);
	await open(page);
	await page.locator("#attach-input").setInputFiles({ name: "big.txt", mimeType: "text/plain", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 97) });
	await expect(page.locator(".toast.error")).toContainText("Files can be at most 10 MB.");
	expect(m.uploads).toHaveLength(0);
});

test("files can be dropped on the composer or pasted into the message box", async ({ page }) => {
	const m = await mock(page);
	await open(page);

	const drop = await page.evaluateHandle(() => {
		const data = new DataTransfer();
		data.items.add(new File(["dropped"], "dropped.txt", { type: "text/plain" }));
		return data;
	});
	await page.locator(".message-input").dispatchEvent("dragover", { dataTransfer: drop });
	await expect(page.locator(".message-input")).toHaveClass(/is-dragover/);
	await page.locator(".message-input").dispatchEvent("drop", { dataTransfer: drop });
	await expect(page.locator(".message-input")).not.toHaveClass(/is-dragover/);
	await expect(page.locator(".file-tray .file-chip")).toHaveCount(1);

	await page.locator("#user-input").evaluate((input) => {
		const data = new DataTransfer();
		data.items.add(new File(["pasted"], "pasted.png", { type: "image/png" }));
		input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
	});
	await expect(page.locator(".file-tray .file-chip")).toHaveCount(2);
	await expect.poll(() => m.uploads.map((u) => u.name)).toEqual(["dropped.txt", "pasted.png"]);
});

test("a reopened conversation shows the chips its turns were sent with", async ({ page }) => {
	const m = await mock(page);
	m.detail = {
		conversation: { id: "c9", title: "With a file", pinned: false, folderId: null, createdAt: 1, updatedAt: 2, activeLeafId: "a1" },
		messages: [
			{
				id: "u1", parentId: null, seq: 1, role: "user", content: "What is in the report?", reasoning: null, model: null,
				status: "complete", compareGroup: null, completionTokens: null, createdAt: 1,
				files: [{ id: FILE_ID, name: "report.pdf", type: "application/pdf", size: 2 * 1024 * 1024, kind: "document" }],
			},
			{
				id: "a1", parentId: "u1", seq: 2, role: "assistant", content: "Sales rose.", reasoning: null, model: "m",
				status: "complete", compareGroup: null, completionTokens: 2, createdAt: 2,
			},
		],
	};
	await open(page);
	await page.evaluate(() => window.chat?.openConversation("c9"));
	const chip = page.locator('.user-turn[data-message-id="u1"] .file-chip');
	await expect(chip.locator(".file-chip-name")).toHaveText("report.pdf");
	await expect(chip.locator(".file-chip-meta")).toHaveText("2.0 MB");
});

test("the attach control and chips follow the page into Arabic", async ({ page }) => {
	await mock(page);
	await open(page);
	await page.evaluate(() => {
		document.documentElement.lang = "ar";
		document.documentElement.dir = "rtl";
	});
	await page.locator("#attach-input").setInputFiles(textFile("ملف.txt"));
	const chip = page.locator(".file-tray .file-chip");
	await expect(chip).toHaveAttribute("data-state", "ready");
	await expect(chip.getByRole("button", { name: "إزالة ملف.txt" })).toBeVisible();
	await expect(chip.locator(".file-chip-meta")).toHaveText("1 ك.ب");
});
