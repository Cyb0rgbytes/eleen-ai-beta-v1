import { afterEach, describe, expect, it } from "vitest";
import { createEmptyState, setGreetingName } from "./empty";

afterEach(() => {
	document.documentElement.lang = "en";
});

describe("empty state", () => {
	it("greets, asks, and offers exactly four cards", () => {
		const node = createEmptyState(null);
		expect(node.querySelector(".empty-hello")?.textContent).toBe("Hello");
		expect(node.querySelector(".empty-ask")?.textContent).toBe("How can I help you today?");
		const cards = node.querySelectorAll<HTMLButtonElement>(".prompt-card");
		expect(cards).toHaveLength(4);
		for (const card of cards) {
			expect(card.type).toBe("button");
			expect(card.dataset.prompt?.length).toBeGreaterThan(10);
			expect(card.querySelector("svg.icon")).not.toBeNull();
		}
	});

	it("hides the /imagine command in the card but keeps it in the prompt", () => {
		const image = [...createEmptyState(null).querySelectorAll<HTMLButtonElement>(".prompt-card")].find((c) =>
			c.dataset.prompt?.startsWith("/imagine "),
		);
		expect(image).toBeDefined();
		expect(image?.querySelector(".prompt-card-body")?.textContent?.startsWith("/imagine")).toBe(false);
	});

	it("greets a signed-in user by name, as text", () => {
		const node = createEmptyState("<b>Mona</b>");
		expect(node.querySelector(".empty-hello")?.textContent).toBe("Hello, <b>Mona</b>");
		expect(node.querySelector("b")).toBeNull();
		setGreetingName(node, null);
		expect(node.querySelector(".empty-hello")?.textContent).toBe("Hello");
	});

	it("speaks Arabic when the page does", () => {
		document.documentElement.lang = "ar";
		const node = createEmptyState(null);
		expect(node.querySelector(".empty-ask")?.textContent).toBe("كيف يمكنني مساعدتك اليوم؟");
	});
});
