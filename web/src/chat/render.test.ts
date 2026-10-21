import { afterEach, describe, expect, it, vi } from "vitest";
import { FRESH_MS, createAssistantMessage, createImageMessage, createNotice, createUserMessage } from "./render";

afterEach(() => {
	document.documentElement.lang = "en";
	vi.useRealTimers();
});

describe("user message", () => {
	it("shows the text as text and lets the browser pick its direction", () => {
		const node = createUserMessage('<img src=x onerror="window.__xss=1">');
		const p = node.querySelector("p");
		expect(p?.textContent).toBe('<img src=x onerror="window.__xss=1">');
		expect(p?.dir).toBe("auto");
		expect(node.querySelector("img")).toBeNull();
	});
});

describe("assistant message", () => {
	it("renders the final reply with chips, feedback and usage", () => {
		const view = createAssistantMessage();
		const extracted = view.finish("**Hi**\n[SUGGEST]Tell me more|Example[/SUGGEST]", { completionTokens: 42 });
		const body = view.root.querySelector(".message-body");
		expect(body?.getAttribute("dir")).toBe("auto");
		expect(body?.querySelector("strong")?.textContent).toBe("Hi");
		expect([...view.root.querySelectorAll(".suggestion-chip")].map((c) => c.textContent)).toEqual([
			"Tell me more",
			"Example",
		]);
		expect(view.root.querySelectorAll("[data-feedback]")).toHaveLength(2);
		expect(view.root.querySelector(".message-usage")?.textContent).toBe("42 tokens");
		expect(extracted.suggestions).toHaveLength(2);
		expect(body?.textContent).not.toContain("[SUGGEST]");
	});

	it("puts hostile chip text in textContent and a data attribute, never markup", () => {
		const view = createAssistantMessage();
		view.finish('ok[SUGGEST]<img src=x onerror="window.__xss=1">[/SUGGEST]');
		const chip = view.root.querySelector(".suggestion-chip") as HTMLButtonElement;
		expect(chip.textContent).toBe('<img src=x onerror="window.__xss=1">');
		expect(chip.dataset.suggestion).toBe('<img src=x onerror="window.__xss=1">');
		expect(view.root.querySelector("img")).toBeNull();
	});

	it("omits usage on a reply without a count", () => {
		const view = createAssistantMessage();
		view.finish("hi");
		expect(view.root.querySelector(".message-usage")).toBeNull();
	});

	it("marks a stopped reply and keeps what had arrived", () => {
		const view = createAssistantMessage();
		view.finish("partial answer", { stopped: true });
		expect(view.root.textContent).toContain("partial answer");
		expect(view.root.querySelector(".message-note")?.textContent).toBe("Stopped.");
	});

	it("batches streaming updates into one paint per frame", () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
		const view = createAssistantMessage();
		view.update("a");
		view.update("ab");
		view.update("abc");
		expect(view.root.querySelector(".message-body")?.textContent).toBe("");
		vi.advanceTimersToNextFrame();
		expect(view.root.querySelector(".message-body")?.textContent).toBe("abc");
	});

	it("fades in text as it streams, and leaves the finished reply plain", () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
		const view = createAssistantMessage();
		const body = () => view.root.querySelector(".message-body")!;

		view.update("Hello");
		vi.advanceTimersToNextFrame();
		expect([...body().querySelectorAll(".fresh")].map((s) => s.textContent).join("")).toBe("Hello");

		// Long after, only the new words are still fading.
		vi.advanceTimersByTime(FRESH_MS + 100);
		view.update("Hello there");
		vi.advanceTimersToNextFrame();
		expect([...body().querySelectorAll(".fresh")].map((s) => s.textContent).join("")).toBe(" there");
		expect(body().textContent).toBe("Hello there");

		view.finish("Hello there");
		expect(body().querySelector(".fresh")).toBeNull();
	});

	it("gives a finished code block a header with its language and a Copy button", () => {
		const view = createAssistantMessage();
		view.finish("Try:\n```python\nprint('hi')\n```");
		const block = view.root.querySelector(".code-block")!;
		expect(block.querySelector(".code-lang")?.textContent).toBe("python");
		expect(block.querySelector<HTMLButtonElement>(".code-copy")?.dataset.action).toBe("copy-code");
		expect(block.querySelector("pre code")?.textContent).toBe("print('hi')");
	});

	it("puts an onward arrow on each follow-up chip", () => {
		const view = createAssistantMessage();
		view.finish("ok[SUGGEST]Why?[/SUGGEST]");
		expect(view.root.querySelector(".suggestion-chip svg.icon")?.getAttribute("data-icon")).toBe("arrow-right");
	});

	it("marks itself receiving while tokens arrive, and settles after", () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
		const view = createAssistantMessage();
		view.update("a");
		expect(view.root.classList.contains("is-receiving")).toBe(true);
		vi.advanceTimersByTime(600);
		expect(view.root.classList.contains("is-receiving")).toBe(false);
		view.update("ab");
		view.finish("ab");
		expect(view.root.classList.contains("is-receiving")).toBe(false);
		expect(view.root.classList.contains("is-streaming")).toBe(false);
	});

	it("shows a designed error state", () => {
		const view = createAssistantMessage();
		view.fail("Could not reach EleenAI.");
		const error = view.root.querySelector(".message-error");
		expect(error?.getAttribute("role")).toBe("alert");
		expect(error?.textContent).toBe("Could not reach EleenAI.");
		expect(view.root.classList.contains("is-error")).toBe(true);
	});

	it("uses Arabic strings when the page is in Arabic", () => {
		document.documentElement.lang = "ar";
		const view = createAssistantMessage();
		view.finish("x", { completionTokens: 5 });
		expect(view.root.querySelector(".message-usage")?.textContent).toBe("5 رمز");
	});
});

describe("reasoning panel", () => {
	it("is absent unless a reasoning event arrives", () => {
		const view = createAssistantMessage();
		view.update("plain answer");
		view.finish("plain answer");
		expect(view.root.querySelector(".reasoning")).toBeNull();
	});

	it("opens with a live clock while thinking, then collapses to the duration once the answer begins", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
		const view = createAssistantMessage();
		view.reason("Let me ");
		view.reason("think.");
		const panel = view.root.querySelector(".reasoning") as HTMLDetailsElement;
		expect(panel.open).toBe(true);
		expect(panel.querySelector(".reasoning-label")?.textContent).toBe("Thinking");
		expect(panel.querySelector(".reasoning-text")?.textContent).toBe("Let me think.");
		// The clock is hidden from the live region, so it is not read out every second.
		expect(panel.querySelector(".reasoning-clock")?.getAttribute("aria-hidden")).toBe("true");

		vi.advanceTimersByTime(3000);
		expect(panel.querySelector(".reasoning-clock")?.textContent).toBe("3s");

		view.update("The answer");
		vi.advanceTimersToNextFrame();
		expect(panel.open).toBe(false);
		expect(panel.querySelector(".reasoning-label")?.textContent).toBe("Thought for 3s");
		expect(panel.querySelector(".reasoning-clock")).toBeNull();
		// The panel survives the answer's repaints; it is not rebuilt.
		expect(view.root.querySelector(".reasoning")).toBe(panel);
		expect(view.root.querySelector(".message-body")?.textContent).toContain("The answer");
	});

	it("stays open if the reader opened it themselves", () => {
		const view = createAssistantMessage();
		view.reason("thinking");
		const panel = view.root.querySelector(".reasoning") as HTMLDetailsElement;
		panel.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		panel.open = true;
		view.finish("answer");
		expect(panel.open).toBe(true);
		expect(panel.querySelector(".reasoning-label")?.textContent).toMatch(/^Thought for \d+s$/);
	});

	it("keeps the thinking out of the copied reply", async () => {
		const { replyText } = await import("./render");
		const view = createAssistantMessage();
		view.reason("secret chain of thought");
		view.finish("final answer");
		expect(replyText.get(view.root)).toBe("final answer");
	});

	it("renders hostile thinking as text", () => {
		const view = createAssistantMessage();
		view.reason('<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
		view.finish("ok");
		expect(view.root.querySelector("img, script")).toBeNull();
		expect(view.root.querySelector(".reasoning-text")?.textContent).toContain("<script>");
	});

	it("settles when a stopped reply ends mid-thought", () => {
		const view = createAssistantMessage();
		view.reason("half a thought");
		view.finish("", { stopped: true });
		expect(view.root.querySelector(".reasoning-label")?.textContent).toMatch(/^Thought for \d+s$/);
	});
});

describe("skeletons", () => {
	it("shapes the first-token wait like the reply it becomes", async () => {
		const { createThinking } = await import("./render");
		const node = createThinking();
		expect(node.getAttribute("role")).toBe("status");
		expect(node.querySelectorAll(".skeleton-line")).toHaveLength(3);
		expect(node.querySelector(".ai-avatar")).not.toBeNull();
		expect(node.textContent).toContain("EleenAI is thinking");
	});

	it("holds the image's place with a 4:3 frame", async () => {
		const { createImageSkeleton } = await import("./render");
		const node = createImageSkeleton("<script>x</script>");
		expect(node.querySelector(".skeleton-image")).not.toBeNull();
		expect(node.querySelector("script")).toBeNull();
	});
});

describe("image and notice", () => {
	it("captions an image with its prompt as text", () => {
		const node = createImageMessage("blob:https://eleenai.xyz/1", '"><script>x</script>');
		expect(node.querySelector("img")?.alt).toBe('"><script>x</script>');
		expect(node.querySelector(".chat-image-caption")?.textContent).toBe('"><script>x</script>');
		expect(node.querySelector("script")).toBeNull();
	});

	it("renders a notice line by line", () => {
		const node = createNotice([{ text: "Welcome." }, { text: "Sign in.", emphasis: true }]);
		expect(node.querySelectorAll("p")).toHaveLength(2);
		expect(node.querySelector("em")?.textContent).toBe("Sign in.");
	});
});
