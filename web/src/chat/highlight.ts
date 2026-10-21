/**
 * Syntax colours for code blocks, loaded on first use.
 *
 * Prism is used only as a tokenizer: Prism.tokenize returns a token tree,
 * never HTML, and each token becomes a <span class="tok tok-TYPE"> whose
 * text is set with textContent. No HTML sink is involved (DESIGN.md,
 * "Rendering model output").
 *
 * This module is imported dynamically by code.ts, so Prism and its grammars
 * ship in their own chunk and cost nothing until a reply contains code.
 */

// Order matters: the flag first, then the core, then grammars after the
// ones they extend.
import "./prism-manual";
import Prism from "prismjs";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";

const ALIASES: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	ts: "typescript",
	tsx: "typescript",
	py: "python",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	console: "bash",
	ps1: "powershell",
	pwsh: "powershell",
	html: "markup",
	xml: "markup",
	svg: "markup",
	yml: "yaml",
	"c++": "cpp",
	cs: "csharp",
	"c#": "csharp",
	golang: "go",
	rs: "rust",
};

/** Token types become class names; anything unexpected is dropped. */
const SAFE_TYPE = /^[a-z][a-z0-9-]{0,30}$/;

function toNodes(stream: string | Prism.Token | (string | Prism.Token)[]): Node[] {
	if (typeof stream === "string") return [document.createTextNode(stream)];
	if (Array.isArray(stream)) return stream.flatMap(toNodes);
	const span = document.createElement("span");
	const kinds = [stream.type, ...(Array.isArray(stream.alias) ? stream.alias : stream.alias ? [stream.alias] : [])];
	span.className = ["tok", ...kinds.filter((k) => SAFE_TYPE.test(k)).map((k) => `tok-${k}`)].join(" ");
	span.append(...toNodes(stream.content));
	return [span];
}

/** Colour one code element in place. Unknown languages are left plain. */
export function highlight(code: HTMLElement): void {
	const lang = (code.dataset.lang ?? "").toLowerCase();
	const grammar = Prism.languages[ALIASES[lang] ?? lang];
	if (!grammar) return;
	const source = code.textContent ?? "";
	code.replaceChildren(...toNodes(Prism.tokenize(source, grammar)));
	code.dataset.highlighted = "";
}
