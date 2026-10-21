import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

function code(lang: string, source: string): HTMLElement {
	const node = document.createElement("code");
	node.dataset.lang = lang;
	node.textContent = source;
	return node;
}

describe("highlight", () => {
	it("colours a known language with spans only, keeping the text exactly", () => {
		const source = "def greet(name):\n    return f\"hi {name}\"  # say hi\n";
		const node = code("py", source);
		highlight(node);
		expect(node.textContent).toBe(source);
		expect(node.querySelector(".tok-keyword")?.textContent).toBe("def");
		expect(node.querySelector(".tok-comment")?.textContent).toBe("# say hi");
		for (const el of node.querySelectorAll("*")) {
			expect(el.tagName).toBe("SPAN");
			expect(el.getAttributeNames()).toEqual(["class"]);
			expect(el.className).toMatch(/^tok( tok-[a-z][a-z0-9-]*)+$/);
		}
	});

	it("never turns code into markup", () => {
		const node = code("html", '<img src=x onerror="window.__xss=1"><script>alert(1)</script>');
		highlight(node);
		expect(node.querySelector("img, script")).toBeNull();
		expect(node.textContent).toContain("<script>");
	});

	it("leaves an unknown language plain", () => {
		const node = code("brainfuck", "+++[>++<-]");
		highlight(node);
		expect(node.children).toHaveLength(0);
		expect(node.textContent).toBe("+++[>++<-]");
	});
});
