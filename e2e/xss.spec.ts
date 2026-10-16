/**
 * The four script-execution paths from the October audit, replayed against
 * the real chat.js in a real browser.
 *
 * Model output is attacker-influenced: a prompt injection can make the model
 * write anything, and chat.js renders it with innerHTML. The chat endpoint is
 * intercepted here and answered with a crafted stream, so no model is called
 * and the payloads are exactly what the audit used.
 */
import { expect, test } from "@playwright/test";

// 1x1 transparent PNG, for the image the [IMG_GEN] tag asks for.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

const PAYLOADS = {
	chip: '[SUGGEST]<img src=x onerror="window.__xss=1">[/SUGGEST]',
	links: 'Click [here](javascript:window.__xss=2) or [there](https://example.com/"onmouseover="window.__xss=3)',
	script: "<script>window.__xss=4</script>",
	image: '[IMG_GEN]x" onload="window.__xss=5[/IMG_GEN]',
};

function sse(text: string): string {
	return `data: ${JSON.stringify({ response: text })}\n\ndata: [DONE]\n\n`;
}

test("hostile model output renders as text, never as script", async ({ page }) => {
	const dialogs: string[] = [];
	page.on("dialog", (d) => {
		dialogs.push(d.message());
		void d.dismiss();
	});

	await page.route("**/api/chat/guest", (route) =>
		route.fulfill({
			status: 200,
			headers: { "content-type": "text/event-stream; charset=utf-8" },
			body: sse(Object.values(PAYLOADS).join("\n\n")),
		}),
	);
	await page.route("**/api/image/generate/guest", (route) =>
		route.fulfill({ status: 200, headers: { "content-type": "image/png" }, body: PNG }),
	);

	await page.goto("/");
	const input = page.locator("#user-input");
	await expect(input).toBeEnabled();
	await input.fill("hello");
	await page.locator("#send-button").click();

	// The final render is what adds the chips; the stream is complete by then.
	const chips = page.locator("#chat-messages .suggestion-chip");
	await expect(chips).toHaveCount(1);
	await expect(chips.first()).toHaveText('<img src=x onerror="window.__xss=1">');

	// Give any onload / onerror handler a moment to fire if it was going to.
	await page.waitForTimeout(500);

	const messages = page.locator("#chat-messages");
	await expect(messages.locator("[onerror], [onload], [onclick], [onmouseover]")).toHaveCount(0);
	await expect(messages.locator('a[href^="javascript:" i]')).toHaveCount(0);
	await expect(messages.locator("script")).toHaveCount(0);

	// The https link survives as a link; its quote-breakout is escaped.
	const links = messages.locator("a[href]");
	for (const href of await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")))) {
		expect(href).toMatch(/^(https?:|mailto:)/);
	}

	expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
	expect(dialogs).toEqual([]);
});
