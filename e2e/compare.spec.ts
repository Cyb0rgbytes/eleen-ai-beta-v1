/**
 * M5.4 in a real browser: choosing 2 or 3 models, the multiplexed stream
 * rendered as columns on a wide screen and tabs on a phone, Continue with
 * this answer, Stop across every lane, and a saved compare turn reopened.
 *
 * Signed-in state is the stand-in Clerk SDK from branching.spec.ts, and
 * every chat and history route is mocked: nothing reaches a model.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

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
	chats: Body[];
	history: { method: string; path: string; body: unknown }[];
	detail: unknown;
}

/** A compare reply: per lane a meta, a token and a usage, ids minted per call. */
function compareFrames(body: Body, turn: number): string {
	const models = (body.compare as string[] | undefined) ?? [];
	const frames: [string, unknown][] = [];
	models.forEach((model, lane) => {
		frames.push([
			"meta",
			{
				protocol: 2,
				lane,
				model: model === "fast" ? "@cf/meta/llama-3.1-8b-instruct-fp8" : "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
				conversationId: "c1",
				userMessageId: `u${turn}`,
				assistantMessageId: `a${turn}-${lane}`,
				compareGroup: `g${turn}`,
			},
		]);
	});
	// Interleaved, as concurrent lanes arrive.
	models.forEach((_, lane) => frames.push(["token", { lane, text: `Lane ${lane} answer ${turn}` }]));
	models.forEach((_, lane) => {
		frames.push(["usage", { lane, completionTokens: 10 + lane }]);
		frames.push(["done", { lane }]);
	});
	frames.push(["done", {}]);
	return v2(frames);
}

async function savedChat(page: Page, { signedIn = true }: { signedIn?: boolean } = {}): Promise<Mock> {
	const mock: Mock = { chats: [], history: [], detail: null };
	await page.route("https://clerk.eleenai.xyz/**", (route) =>
		route.fulfill({ contentType: "application/javascript", body: fakeClerk(signedIn) }),
	);
	await page.route("**/api/v1/keys", (route) => route.fulfill({ json: { keys: [] } }));
	await page.route("**/api/v1/consent", (route) =>
		route.fulfill({ json: { consent: { history: true, memory: false, policyVersion: 1, updatedAt: 1 }, policyVersion: 1 } }),
	);
	await page.route("**/api/v1/folders**", (route) => route.fulfill({ json: { folders: [] } }));
	await page.route(/\/api\/v1\/conversations(\/[^?]*)?(\?.*)?$/, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET" && path === "/api/v1/conversations") {
			return route.fulfill({ json: { conversations: [], nextCursor: null } });
		}
		const raw = request.postData();
		mock.history.push({ method: request.method(), path, body: raw ? JSON.parse(raw) : null });
		if (request.method() === "GET") return route.fulfill({ json: mock.detail });
		const id = decodeURIComponent(path.split("/")[4] ?? "");
		return route.fulfill({
			json: { conversation: { id, title: "Saved", pinned: false, folderId: null, createdAt: 1, updatedAt: 2 } },
		});
	});

	let turn = 0;
	await page.route("**/api/chat", async (route: Route) => {
		const body = JSON.parse(route.request().postData() ?? "{}") as Body;
		mock.chats.push(body);
		turn++;
		const frames = body.compare
			? compareFrames(body, turn)
			: v2([
					["meta", { model: "m", protocol: 2, conversationId: "c1", userMessageId: `u${turn}`, assistantMessageId: `a${turn}` }],
					["token", { text: `Reply ${turn}` }],
					["done", {}],
				]);
		await route.fulfill({ headers: { "content-type": "text/event-stream" }, body: frames });
	});
	return mock;
}

async function open(page: Page) {
	const consent = page.waitForResponse((r) => r.url().includes("/api/v1/consent"));
	const models = page.waitForResponse((r) => r.url().includes("/api/v1/models"));
	await page.goto("/");
	await Promise.all([consent, models]);
	await expect(page.locator("#logout-button")).toBeVisible();
	await page.waitForTimeout(150);
}

async function send(page: Page, text: string) {
	const input = page.locator("#user-input");
	await expect(input).toBeEnabled();
	await input.fill(text);
	await page.locator("#send-button").click();
	await expect(page.locator("#send-button")).toHaveAttribute("title", "Send");
}

/** Open the chooser and pick these models by their names. */
async function chooseModels(page: Page, names: string[]) {
	await page.locator("#compare-btn").click();
	const dialog = page.getByRole("dialog", { name: "Compare models" });
	await expect(dialog).toBeVisible();
	for (const name of names) await dialog.getByRole("checkbox", { name: new RegExp(name) }).check();
	await dialog.getByRole("button", { name: "Compare", exact: true }).click();
	await expect(dialog).toHaveCount(0);
}

const lane = (page: Page, index: number) => page.locator(`.compare-turn .compare-lane[data-lane="${index}"]`).last();

test("chooses two models, streams both lanes side by side, and continues with the second", async ({ page }) => {
	const mock = await savedChat(page);
	await open(page);

	await chooseModels(page, ["Llama 3.1 8B", "Llama 3.3 70B"]);
	const toggle = page.locator("#compare-btn");
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(toggle).toHaveText("Compare 2");

	await send(page, "Which is faster?");
	expect(mock.chats[0]).toMatchObject({ compare: ["fast", "smart"], parentId: null, protocol: 2, messages: [{ role: "user", content: "Which is faster?" }] });
	expect(mock.chats[0]).not.toHaveProperty("model");

	const turn = page.locator(".compare-turn");
	await expect(turn).toHaveCount(1);
	await expect(turn).toHaveAttribute("data-message-id", "a1-0");
	// Columns at desktop width: both lanes visible, no tabs.
	await expect(lane(page, 0)).toBeVisible();
	await expect(lane(page, 1)).toBeVisible();
	await expect(turn.locator(".compare-tabs")).toBeHidden();
	const [first, second] = await Promise.all([lane(page, 0).boundingBox(), lane(page, 1).boundingBox()]);
	expect(Math.abs((first?.y ?? 0) - (second?.y ?? 1))).toBeLessThan(2);
	await expect(lane(page, 0).locator(".compare-lane-model")).toHaveText("Llama 3.1 8B");
	await expect(lane(page, 1).locator(".compare-lane-model")).toHaveText("Llama 3.3 70B");
	await expect(lane(page, 0)).toContainText("Lane 0 answer 1");
	await expect(lane(page, 1)).toContainText("Lane 1 answer 1");
	await expect(lane(page, 1).locator(".message-usage")).toHaveText("11 tokens");
	await expect(lane(page, 0).locator(".compare-lane-chosen")).toBeVisible();
	await expect(page.locator(".regenerate-button")).toHaveCount(0);

	await lane(page, 1).getByRole("button", { name: "Continue with this answer" }).click();
	await expect(lane(page, 1).locator(".compare-lane-chosen")).toBeVisible();
	await expect(lane(page, 0).getByRole("button", { name: "Continue with this answer" })).toBeVisible();
	await expect.poll(() => mock.history.filter((r) => r.method === "PATCH").at(-1)).toEqual({
		method: "PATCH",
		path: "/api/v1/conversations/c1",
		body: { activeLeafId: "a1-1" },
	});

	// Back to one model; the next turn follows the chosen answer.
	await toggle.click();
	await page.getByRole("dialog", { name: "Compare models" }).getByRole("button", { name: "Turn off" }).click();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await send(page, "Go on");
	expect(mock.chats.at(-1)).toMatchObject({ conversationId: "c1", parentId: "a1-1" });
	expect(mock.chats.at(-1)).not.toHaveProperty("compare");
	await expect(page.locator('.assistant-message[data-message-id="a2"]')).toContainText("Reply 2");
});

test("allows at most three models, and none that are locked", async ({ page }) => {
	await savedChat(page);
	await open(page);
	await page.locator("#compare-btn").click();
	const dialog = page.getByRole("dialog", { name: "Compare models" });
	const apply = dialog.getByRole("button", { name: "Compare", exact: true });
	await expect(apply).toBeDisabled();
	await dialog.getByRole("checkbox", { name: /Llama 3\.1 8B/ }).check();
	await expect(apply).toBeDisabled();
	await dialog.getByRole("checkbox", { name: /Llama 3\.3 70B/ }).check();
	await dialog.getByRole("checkbox", { name: /DeepSeek/ }).check();
	await expect(dialog.getByRole("status")).toHaveText("3 of 3 chosen");
	await expect(apply).toBeEnabled();
	// A premium model without a key is locked, with its reason.
	const premium = dialog.getByRole("checkbox", { name: /GPT-5\.5/ });
	await expect(premium).toBeDisabled();
	await expect(dialog.locator(".compare-option.is-locked").first()).toContainText("Add your key");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(page.locator("#compare-btn")).toHaveAttribute("aria-pressed", "false");
});

test("shows one lane at a time as tabs on a phone", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await savedChat(page);
	await open(page);
	await chooseModels(page, ["Llama 3.1 8B", "Llama 3.3 70B"]);
	await send(page, "Compare on a phone");

	const tabs = page.locator(".compare-turn [role='tab']");
	await expect(tabs).toHaveCount(2);
	await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
	await expect(lane(page, 0)).toBeVisible();
	await expect(lane(page, 1)).toBeHidden();
	await tabs.nth(1).click();
	await expect(lane(page, 1)).toBeVisible();
	await expect(lane(page, 0)).toBeHidden();
	await expect(lane(page, 1)).toContainText("Lane 1 answer 1");
});

test("Stop stops every lane", async ({ page }) => {
	await savedChat(page);
	await page.addInitScript(() => {
		const real = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!url.endsWith("/api/chat")) return real(input, init);
			const encoder = new TextEncoder();
			const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
			const ids = { protocol: 2, conversationId: "c1", userMessageId: "uh", compareGroup: "gh" };
			const frames =
				frame("meta", { ...ids, lane: 0, model: "m0", assistantMessageId: "ah0" }) +
				frame("meta", { ...ids, lane: 1, model: "m1", assistantMessageId: "ah1" }) +
				frame("token", { lane: 0, text: "Partial zero" }) +
				frame("token", { lane: 1, text: "Partial one" });
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(frames));
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		};
	});
	await open(page);
	await chooseModels(page, ["Llama 3.1 8B", "Llama 3.3 70B"]);
	await page.locator("#user-input").fill("Write two essays");
	await page.locator("#send-button").click();
	await expect(lane(page, 1)).toContainText("Partial one");
	await page.waitForTimeout(600);
	await page.locator("#send-button").click();

	for (const index of [0, 1]) {
		await expect(lane(page, index).locator(".message-note")).toHaveText("Stopped. What was written so far is saved.");
	}
	await expect(lane(page, 0)).toContainText("Partial zero");
	await expect(page.locator("#send-button")).toHaveAttribute("title", "Send");
});

test("a guest pressing Compare is asked to sign in", async ({ page }) => {
	await savedChat(page, { signedIn: false });
	await page.goto("/");
	await expect(page.locator("#compare-btn")).toBeVisible();
	await page.locator("#compare-btn").click();
	await expect.poll(() => page.evaluate(() => (window as unknown as { __signInOpened?: boolean }).__signInOpened)).toBe(true);
	await expect(page.getByRole("dialog", { name: "Compare models" })).toHaveCount(0);
});

test("reopening a saved conversation shows its compare turn again, counted once", async ({ page }) => {
	const mock = await savedChat(page);
	const m = (id: string, seq: number, role: "user" | "assistant", parentId: string | null, content: string, extra: Record<string, unknown> = {}) => ({
		id,
		parentId,
		seq,
		role,
		content,
		reasoning: null,
		model: null,
		status: "complete",
		compareGroup: null,
		completionTokens: null,
		createdAt: seq,
		...extra,
	});
	mock.detail = {
		conversation: { id: "c7", title: "Compared", pinned: false, folderId: null, createdAt: 1, updatedAt: 5, activeLeafId: "k1" },
		messages: [
			m("q1", 1, "user", null, "Original question"),
			m("r1", 2, "assistant", "q1", "A single answer"),
			m("k0", 3, "assistant", "q1", "Fast compared", { model: "@cf/meta/llama-3.1-8b-instruct-fp8", compareGroup: "g" }),
			m("k1", 4, "assistant", "q1", "Smart compared", { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", compareGroup: "g" }),
		],
	};
	await open(page);
	await page.evaluate(() => window.chat?.openConversation("c7"));

	const turn = page.locator(".compare-turn");
	await expect(turn).toHaveAttribute("data-message-id", "k1");
	await expect(turn.locator(".compare-lane")).toHaveCount(2);
	await expect(turn.locator(".compare-head .branch-count")).toHaveText("2/2");
	await expect(lane(page, 1).locator(".compare-lane-chosen")).toBeVisible();
	await expect(lane(page, 0).locator(".compare-lane-model")).toHaveText("Llama 3.1 8B");

	await turn.getByRole("button", { name: "Previous version" }).click();
	await expect(page.locator(".compare-turn")).toHaveCount(0);
	await expect(page.locator('.assistant-message[data-message-id="r1"]')).toContainText("A single answer");
	// Back to the compare turn: nothing was continued from either lane, so it opens on the first.
	await page.locator('.assistant-message[data-message-id="r1"]').getByRole("button", { name: "Next version" }).click();
	await expect(page.locator(".compare-turn")).toHaveAttribute("data-message-id", "k0");
	await lane(page, 1).getByRole("button", { name: "Continue with this answer" }).click();
	await expect(page.locator(".compare-turn")).toHaveAttribute("data-message-id", "k1");

	// A new single-model turn follows the lane that was continued from.
	await send(page, "follow up");
	expect(mock.chats.at(-1)).toMatchObject({ conversationId: "c7", parentId: "k1" });
});
