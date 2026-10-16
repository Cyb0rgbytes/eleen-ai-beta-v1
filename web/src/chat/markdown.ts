/**
 * Markdown to DOM, safely.
 *
 * Model output is attacker-influenced (DESIGN.md, "Rendering model output"),
 * so this never produces an HTML string. marked is used only as a lexer;
 * every node is created here with createElement from an allowlist, and
 * every attribute is set individually from a value we checked.
 *
 * - Raw HTML in the source is rendered as text.
 * - Links pass safeHref (http, https, mailto) and open in a new tab with
 *   rel="noopener noreferrer nofollow"; anything else renders as its label.
 * - Images never become <img>: a model-written image URL is the classic
 *   exfiltration channel. They render as a link to the URL instead.
 * - Code blocks are dir="ltr" in every UI direction.
 */
import { Lexer, type Token, type Tokens } from "marked";

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The href to use for a model-written URL, or null if it must not link. */
export function safeHref(raw: string): string | null {
	const value = raw.trim();
	if (!value) return null;
	try {
		const url = new URL(value, window.location.origin);
		return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

const LANG = /^[A-Za-z0-9_+#.-]{1,24}$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, children: Node[] = []): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.append(...children);
	return node;
}

function text(value: string): Text {
	return document.createTextNode(value);
}

function link(label: Node[], href: string | null): Node[] {
	if (href === null) return label;
	const a = el("a", label);
	a.href = href;
	a.target = "_blank";
	a.rel = "noopener noreferrer nofollow";
	return [a];
}

function inline(tokens: Token[] | undefined): Node[] {
	const out: Node[] = [];
	for (const token of tokens ?? []) out.push(...inlineToken(token));
	return out;
}

function inlineToken(token: Token): Node[] {
	switch (token.type) {
		case "text": {
			const t = token as Tokens.Text;
			// A text token inside a list item can carry its own inline tokens.
			return t.tokens ? inline(t.tokens) : [text(t.text)];
		}
		case "escape":
			return [text((token as Tokens.Escape).text)];
		case "strong":
			return [el("strong", inline((token as Tokens.Strong).tokens))];
		case "em":
			return [el("em", inline((token as Tokens.Em).tokens))];
		case "del":
			return [el("del", inline((token as Tokens.Del).tokens))];
		case "codespan":
			return [el("code", [text((token as Tokens.Codespan).text)])];
		case "br":
			return [el("br")];
		case "link": {
			const t = token as Tokens.Link;
			return link(inline(t.tokens), safeHref(t.href));
		}
		case "image": {
			// Never an <img>. Shown as a link labelled with its alt text.
			const t = token as Tokens.Image;
			const label = t.text.trim() || t.href;
			return link([text(label)], safeHref(t.href));
		}
		case "html":
			return [text((token as Tokens.HTML).raw)];
		default:
			return "raw" in token && typeof token.raw === "string" ? [text(token.raw)] : [];
	}
}

function block(token: Token): Node[] {
	switch (token.type) {
		case "space":
		case "def":
			return [];
		case "paragraph":
			return [el("p", inline((token as Tokens.Paragraph).tokens))];
		case "heading": {
			// Chat replies sit under the page's own headings, so h1 and h2
			// render as h3 and everything deeper as h4 or h5.
			const t = token as Tokens.Heading;
			const tag = t.depth <= 2 ? "h3" : t.depth === 3 ? "h4" : "h5";
			return [el(tag, inline(t.tokens))];
		}
		case "code": {
			const t = token as Tokens.Code;
			const code = el("code", [text(t.text)]);
			const lang = (t.lang ?? "").split(/\s/)[0] ?? "";
			if (LANG.test(lang)) code.dataset.lang = lang;
			const pre = el("pre", [code]);
			pre.dir = "ltr";
			return [pre];
		}
		case "blockquote":
			return [el("blockquote", blocks((token as Tokens.Blockquote).tokens))];
		case "list": {
			const t = token as Tokens.List;
			const list = el(t.ordered ? "ol" : "ul", t.items.map((item) => el("li", listItem(item))));
			if (t.ordered && typeof t.start === "number" && t.start !== 1 && t.start >= 0 && t.start < 1e6) {
				(list as HTMLOListElement).start = t.start;
			}
			return [list];
		}
		case "hr":
			return [el("hr")];
		case "table": {
			const t = token as Tokens.Table;
			const head = el("thead", [el("tr", t.header.map((cell) => el("th", inline(cell.tokens))))]);
			const body = el(
				"tbody",
				t.rows.map((row) => el("tr", row.map((cell) => el("td", inline(cell.tokens))))),
			);
			const table = el("table", [head, body]);
			// A wide table scrolls inside the panel instead of widening it.
			const wrap = el("div", [table]);
			wrap.className = "md-table";
			return [wrap];
		}
		case "html":
			return [el("p", [text((token as Tokens.HTML).raw)])];
		case "text": {
			const t = token as Tokens.Text;
			return [el("p", t.tokens ? inline(t.tokens) : [text(t.text)])];
		}
		default:
			return "raw" in token && typeof token.raw === "string" ? [el("p", [text(token.raw)])] : [];
	}
}

function listItem(item: Tokens.ListItem): Node[] {
	const out: Node[] = [];
	for (const token of item.tokens) {
		// Tight list items hold bare text; loose ones hold paragraphs.
		if (token.type === "text") out.push(...inlineToken(token));
		else out.push(...block(token));
	}
	return out;
}

function blocks(tokens: Token[]): Node[] {
	const out: Node[] = [];
	for (const token of tokens) out.push(...block(token));
	return out;
}

/** Render markdown into a fragment of safe nodes. */
export function renderMarkdown(source: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	if (!source) return fragment;
	const tokens = Lexer.lex(source, { gfm: true, breaks: true });
	fragment.append(...blocks(tokens));
	return fragment;
}

/** Elements the renderer may produce. Exported so tests can enforce it. */
export const ALLOWED_ELEMENTS = new Set([
	"P", "BR", "STRONG", "EM", "DEL", "CODE", "PRE", "UL", "OL", "LI", "BLOCKQUOTE",
	"A", "H3", "H4", "H5", "HR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "DIV",
]);

/** Attributes the renderer may set, per element. */
export const ALLOWED_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
	A: new Set(["href", "target", "rel"]),
	OL: new Set(["start"]),
	PRE: new Set(["dir"]),
	CODE: new Set(["data-lang"]),
	DIV: new Set(["class"]),
};
