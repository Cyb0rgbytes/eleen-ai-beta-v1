import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessage, createImageMessage, createNotice, createUserMessage } from "./render";

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
