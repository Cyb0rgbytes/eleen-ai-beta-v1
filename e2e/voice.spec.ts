/**
 * Voice input sends itself once transcribed. Chromium's fake microphone
 * supplies the audio; transcription and the reply are mocked, so nothing
 * here costs inference.
 */
import { expect, test, type Page } from "@playwright/test";

test.use({
	permissions: ["microphone"],
	launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

const v2 = (frames: [string, unknown][]) =>
	frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

async function mock(page: Page, transcript: string) {
	const sent: Record<string, unknown>[] = [];
	let transcribed = 0;
	await page.route("**/api/voice/transcribe/guest", async (route) => {
		transcribed++;
		await route.fulfill({ json: { text: transcript } });
	});
	await page.route("**/api/chat/guest", async (route) => {
		sent.push(JSON.parse(route.request().postData() ?? "{}"));
		await route.fulfill({ headers: { "content-type": "text/event-stream" }, body: v2([["token", { text: "Sunny." }], ["done", {}]]) });
	});
	return { sent, transcriptions: () => transcribed };
}

/**
 * Spoken replies: the speak route is mocked, and playback is held open (a
 * play() that resolves and never ends) so the speaking state can be seen.
 */
async function mockSpeech(page: Page) {
	const spoken: string[] = [];
	await page.addInitScript(() => {
		// The mock bytes are not decodable audio; a stand-in player keeps
		// "playing" until it is paused, as a long reply would.
		window.Audio = class {
			src = "";
			onended: (() => void) | null = null;
			onerror: (() => void) | null = null;
			pause() {}
			play() {
				return Promise.resolve();
			}
		} as unknown as typeof Audio;
	});
	await page.route("**/api/voice/speak/guest", async (route) => {
		spoken.push((JSON.parse(route.request().postData() ?? "{}") as { text: string }).text);
		await route.fulfill({ headers: { "content-type": "audio/mpeg" }, body: Buffer.from([0x49, 0x44, 0x33, 4, 0]) });
	});
	return spoken;
}

async function record(page: Page) {
	const mic = page.locator("#mic-button");
	await expect(page.locator("#user-input")).toBeEnabled();
	await mic.click();
	await expect(mic).toHaveClass(/recording/);
	await page.waitForTimeout(700);
	return mic;
}

test("a recording is sent as soon as it is transcribed, with what was already typed", async ({ page }) => {
	const { sent } = await mock(page, "what is the weather today");
	await page.goto("/");
	await page.locator("#user-input").fill("Hello,");
	const mic = await record(page);
	await mic.click();

	await expect(page.locator(".user-message").last()).toHaveText("Hello, what is the weather today");
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("Sunny.");
	await expect(page.locator("#user-input")).toHaveValue("");
	const messages = sent[0]?.messages as { role: string; content: string }[];
	expect(messages.at(-1)).toEqual({ role: "user", content: "Hello, what is the weather today" });
	expect(sent).toHaveLength(1);
});

test("Escape while recording cancels: nothing is transcribed or sent", async ({ page }) => {
	const { sent, transcriptions } = await mock(page, "should never arrive");
	await page.goto("/");
	const mic = await record(page);
	await page.keyboard.press("Escape");
	await expect(mic).not.toHaveClass(/recording/);
	await page.waitForTimeout(800);
	expect(transcriptions()).toBe(0);
	expect(sent).toHaveLength(0);
	await expect(page.locator(".user-message")).toHaveCount(0);
});

test("a question asked by voice is answered aloud, and asks for a speakable reply", async ({ page }) => {
	const { sent } = await mock(page, "what is the weather today");
	const spoken = await mockSpeech(page);
	await page.goto("/");
	const mic = await record(page);
	await mic.click();

	const reply = page.locator(".assistant-message").last();
	await expect(reply).toHaveClass(/is-speaking/);
	await expect(reply.locator(".speak-button")).toHaveAttribute("aria-pressed", "true");
	expect(spoken).toEqual(["Sunny."]);
	expect(sent[0]?.voice).toBe(true);

	// Escape silences it.
	await page.keyboard.press("Escape");
	await expect(reply).not.toHaveClass(/is-speaking/);
});

test("a typed question is not read aloud, but its Speak button reads it and stops it", async ({ page }) => {
	const { sent } = await mock(page, "");
	const spoken = await mockSpeech(page);
	await page.goto("/");
	await page.locator("#user-input").fill("weather?");
	await page.locator("#send-button").click();

	const reply = page.locator(".assistant-message").last();
	await expect(reply.locator(".message-body p").first()).toHaveText("Sunny.");
	await page.waitForTimeout(300);
	expect(spoken).toHaveLength(0);
	expect(sent[0]?.voice).toBeUndefined();

	const speak = reply.locator(".speak-button");
	await speak.click();
	await expect(reply).toHaveClass(/is-speaking/);
	expect(spoken).toEqual(["Sunny."]);
	await speak.click();
	await expect(reply).not.toHaveClass(/is-speaking/);
});

test("with spoken replies off, a voice question is answered in text only", async ({ page }) => {
	await mock(page, "what is the weather today");
	const spoken = await mockSpeech(page);
	await page.goto("/");
	const toggle = page.locator("#voice-out-btn");
	await expect(toggle).toHaveAttribute("data-mode", "auto");
	await toggle.click();
	await expect(toggle).toHaveAttribute("data-mode", "always");
	await toggle.click();
	await expect(toggle).toHaveAttribute("data-mode", "off");

	const mic = await record(page);
	await mic.click();
	await expect(page.locator(".assistant-message .message-body p").last()).toHaveText("Sunny.");
	await page.waitForTimeout(300);
	expect(spoken).toHaveLength(0);
	await expect(page.locator(".assistant-message.is-speaking")).toHaveCount(0);
});

test("an empty transcript sends nothing and says so", async ({ page }) => {
	const { sent } = await mock(page, "");
	await page.goto("/");
	const mic = await record(page);
	await mic.click();
	await expect(page.locator(".toast")).toContainText("Didn't catch anything");
	expect(sent).toHaveLength(0);
	await expect(page.locator(".user-message")).toHaveCount(0);
});
