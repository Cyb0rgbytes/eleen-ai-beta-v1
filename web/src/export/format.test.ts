import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../../../src/shared/history";
import {
	balanceFences,
	defangMarkdown,
	buildJson,
	buildMarkdown,
	escapeMarkdownInline,
	EXPORT_VERSION,
	exportFilename,
	type ExportConversation,
} from "./format";
import { fallbackTitle, fromClientHistory, fromTree } from "./source";

const AT = new Date("2026-10-23T18:04:05.000Z");

const chat: ExportConversation = {
	title: "Tea brewing guide",
	messages: [
		{ role: "user", content: "How hot should the water be?", createdAt: Date.parse("2026-10-23T18:00:00Z") },
		{
			role: "assistant",
			content: "About **80 C** for green tea.\n\n```python\nprint('steep')\n```",
			model: "@cf/meta/llama-3.1-8b-instruct-fp8",
			createdAt: Date.parse("2026-10-23T18:00:05Z"),
		},
	],
};

describe("buildMarkdown", () => {
	it("writes a title, the date, and each turn under its speaker", () => {
		const md = buildMarkdown(chat, { exportedAt: AT });
		expect(md.startsWith("# Tea brewing guide\n\n_Exported from EleenAI on ")).toBe(true);
		expect(md).toContain("2026");
		expect(md).toContain("---\n\n**You**\n\nHow hot should the water be?\n");
		expect(md).toContain("---\n\n**EleenAI**\n\nAbout **80 C** for green tea.");
		expect(md.indexOf("**You**")).toBeLessThan(md.indexOf("**EleenAI**"));
		expect(md.endsWith("```\n")).toBe(true);
	});

	it("keeps code blocks exactly as written", () => {
		const md = buildMarkdown(chat, { exportedAt: AT });
		expect(md).toContain("```python\nprint('steep')\n```");
	});

	it("closes a code fence a stopped reply left open", () => {
		const md = buildMarkdown(
			{ title: "t", messages: [{ role: "assistant", content: "Here:\n```js\nconst a = 1;" }, { role: "user", content: "thanks" }] },
			{ exportedAt: AT },
		);
		expect(md).toContain("```js\nconst a = 1;\n```\n\n---\n\n**You**\n\nthanks");
	});

	it("leaves Arabic and mixed-direction text untouched", () => {
		const arabic = "ما هي أفضل درجة حرارة لتحضير الشاي الأخضر؟ use 80°C";
		const md = buildMarkdown({ title: "الشاي", messages: [{ role: "user", content: arabic }] }, { exportedAt: AT });
		expect(md).toContain(`\n${arabic}\n`);
		expect(md).toContain("# الشاي\n");
		// No bidi controls were added anywhere.
		expect(/[‎‏‪-‮⁦-⁩]/.test(md)).toBe(false);
	});

	it("escapes Markdown in the title and keeps it on one line", () => {
		const md = buildMarkdown({ title: "# *Bold* [link](x)\nsecond", messages: [] }, { exportedAt: AT });
		expect(md.split("\n")[0]).toBe("# \\# \\*Bold\\* \\[link\\]\\(x\\) second");
	});

	it("uses the labels it is given, and a fallback title", () => {
		const md = buildMarkdown(
			{ title: "  ", messages: [{ role: "user", content: "مرحبا" }] },
			{ exportedAt: AT, labels: { user: "أنت", assistant: "EleenAI", exported: "صُدّرت في {date}", untitled: "محادثة" }, lang: "ar" },
		);
		expect(md).toContain("# محادثة\n");
		expect(md).toContain("**أنت**");
		expect(md).toContain("_صُدّرت في ");
	});
});

describe("balanceFences", () => {
	it("leaves balanced text alone", () => {
		const text = "a\n```\nb\n```\nc";
		expect(balanceFences(text)).toBe(text);
	});

	it("matches a fence by character and length", () => {
		expect(balanceFences("````md\n```\ninner\n```")).toBe("````md\n```\ninner\n```\n````");
		expect(balanceFences("~~~\ncode")).toBe("~~~\ncode\n~~~");
	});

	it("ignores inline triple backticks", () => {
		expect(balanceFences("use ```x``` inline")).toBe("use ```x``` inline");
	});
});

describe("defangMarkdown", () => {
	it("turns images into links and escapes raw HTML outside code", () => {
		expect(defangMarkdown("see ![chart](https://x.example/p.png?d=secret)")).toBe("see [chart](https://x.example/p.png?d=secret)");
		expect(defangMarkdown("![ref][1]")).toBe("[ref][1]");
		expect(defangMarkdown('<img src="https://x.example/a.png"> and </div>')).toBe('&lt;img src="https://x.example/a.png"> and &lt;/div>');
		expect(defangMarkdown("<!-- hidden -->")).toBe("&lt;!-- hidden -->");
	});

	it("leaves code, comparisons and Arabic text alone", () => {
		const fenced = "```html\n<img src=x>\n![a](b)\n```";
		expect(defangMarkdown(fenced)).toBe(fenced);
		expect(defangMarkdown("use `<b>` and `![a](b)` here")).toBe("use `<b>` and `![a](b)` here");
		expect(defangMarkdown("if a < 3 and b<=4")).toBe("if a < 3 and b<=4");
		expect(defangMarkdown("مرحبا ![صورة](https://x.example/i.png)")).toBe("مرحبا [صورة](https://x.example/i.png)");
	});

	it("is applied to every turn of a Markdown export", () => {
		const md = buildMarkdown({ title: "t", messages: [{ role: "assistant", content: "![x](https://x.example/i.png)" }] });
		expect(md).toContain("[x](https://x.example/i.png)");
		expect(md).not.toContain("![x]");
	});
});

describe("escapeMarkdownInline", () => {
	it("escapes syntax characters and leading list markers", () => {
		expect(escapeMarkdownInline("a_b*c`d")).toBe("a\\_b\\*c\\`d");
		expect(escapeMarkdownInline("1. one")).toBe("1\\. one");
		expect(escapeMarkdownInline("- dash")).toBe("\\- dash");
	});
});

describe("buildJson", () => {
	it("has the documented version 1 shape", () => {
		const json = JSON.parse(buildJson(chat, { exportedAt: AT }));
		expect(json).toEqual({
			version: EXPORT_VERSION,
			title: "Tea brewing guide",
			exportedAt: "2026-10-23T18:04:05.000Z",
			messages: [
				{ role: "user", content: "How hot should the water be?", createdAt: "2026-10-23T18:00:00.000Z" },
				{
					role: "assistant",
					content: chat.messages[1]?.content,
					model: "@cf/meta/llama-3.1-8b-instruct-fp8",
					createdAt: "2026-10-23T18:00:05.000Z",
				},
			],
		});
		expect(EXPORT_VERSION).toBe(1);
	});

	it("omits model and createdAt when unknown (a guest chat)", () => {
		const json = JSON.parse(buildJson({ title: "x", messages: [{ role: "user", content: "<b>hi</b> \"q\"" }] }, { exportedAt: AT }));
		expect(json.messages).toEqual([{ role: "user", content: "<b>hi</b> \"q\"" }]);
		expect("tree" in json).toBe(false);
	});

	it("includes the whole tree only when asked", () => {
		const conversation = fromTree("Branches", stored, "a2");
		expect("tree" in JSON.parse(buildJson(conversation, { exportedAt: AT }))).toBe(false);
		const json = JSON.parse(buildJson(conversation, { exportedAt: AT, includeTree: true }));
		expect(json.tree.activeLeafId).toBe("a2");
		expect(json.tree.messages.map((m: { id: string }) => m.id)).toEqual(["u1", "a1", "a2"]);
		expect(json.tree.messages[2]).toMatchObject({ id: "a2", parentId: "u1", role: "assistant", status: "complete" });
	});
});

describe("exportFilename", () => {
	it("slugs the title and adds the date", () => {
		expect(exportFilename("Tea brewing guide", "md", AT)).toBe("eleenai-tea-brewing-guide-2026-10-23.md");
	});

	it("drops path separators, reserved and control characters", () => {
		const name = exportFilename('../../etc/passwd: <a|b>?*"\u0000‮', "json", AT);
		expect(name).toBe("eleenai-etc-passwd-a-b-2026-10-23.json");
		expect(name).not.toMatch(/[\\/:*?"<>|\u0000-\u001f‮]/);
	});

	it("keeps Arabic letters", () => {
		expect(exportFilename("الشاي الأخضر", "md", AT)).toBe("eleenai-الشاي-الأخضر-2026-10-23.md");
	});

	it("falls back to 'chat' and bounds the length", () => {
		expect(exportFilename("...", "md", AT)).toBe("eleenai-chat-2026-10-23.md");
		expect(exportFilename("x".repeat(500), "md", AT).length).toBeLessThanOrEqual("eleenai--2026-10-23.md".length + 60);
	});
});

const message = (id: string, parentId: string | null, seq: number, role: "user" | "assistant", content: string): StoredMessage => ({
	id,
	parentId,
	seq,
	role,
	content,
	reasoning: null,
	model: role === "assistant" ? "m" : null,
	status: "complete",
	compareGroup: null,
	completionTokens: null,
	createdAt: 1_700_000_000_000 + seq,
});

const stored = [
	message("a2", "u1", 3, "assistant", "second answer"),
	message("u1", null, 1, "user", "question"),
	message("a1", "u1", 2, "assistant", "first answer"),
];

describe("sources", () => {
	it("a saved chat exports the branch on screen", () => {
		expect(fromTree("T", stored, "a1").messages.map((m) => m.content)).toEqual(["question", "first answer"]);
		// No leaf: the newest branch, as the page shows it.
		expect(fromTree("T", stored, null).messages.map((m) => m.content)).toEqual(["question", "second answer"]);
		expect(fromTree("", stored, "a1").title).toBe("question");
	});

	it("a guest chat drops the greeting and rating notes", () => {
		const greeting = "Welcome!";
		const conversation = fromClientHistory(
			[
				{ role: "assistant", content: greeting },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello\n\n[User rated this response as: Good]" },
			],
			greeting,
		);
		expect(conversation.messages).toEqual([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]);
		expect(conversation.title).toBe("hi");
	});

	it("the fallback title is the first user line, bounded", () => {
		expect(fallbackTitle([{ role: "user", content: `  ${"word ".repeat(30)}` }]).length).toBeLessThanOrEqual(60);
		expect(fallbackTitle([])).toBe("");
	});
});
