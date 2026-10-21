/**
 * Finished code blocks get a header (the language and a Copy button) and,
 * once the highlighter has loaded, syntax colours.
 *
 * This runs on a reply's final render only: while it streams, the body is
 * rebuilt every frame and a code block may still be half written.
 */
import { t } from "../i18n";
import { icon } from "../ui/icons";

let highlighter: Promise<typeof import("./highlight")> | null = null;

function codeHeader(lang: string): HTMLElement {
	const head = document.createElement("div");
	head.className = "code-head";
	const label = document.createElement("span");
	label.className = "code-lang";
	label.textContent = lang || t("code");
	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "message-action code-copy";
	copy.dataset.action = "copy-code";
	copy.title = t("copyCode");
	const sr = document.createElement("span");
	sr.className = "sr-only";
	sr.textContent = t("copyCode");
	copy.append(icon("copy"), sr);
	head.append(label, copy);
	return head;
}

export function enhanceCode(body: HTMLElement): void {
	const blocks = [...body.querySelectorAll<HTMLPreElement>("pre")].filter((pre) => !pre.closest(".code-block"));
	if (!blocks.length) return;

	for (const pre of blocks) {
		const code = pre.querySelector("code");
		const wrap = document.createElement("div");
		wrap.className = "code-block";
		pre.replaceWith(wrap);
		wrap.append(codeHeader(code?.dataset.lang ?? ""), pre);
	}

	const coded = blocks.map((pre) => pre.querySelector<HTMLElement>("code[data-lang]")).filter((c): c is HTMLElement => !!c);
	if (!coded.length) return;
	highlighter ??= import("./highlight");
	highlighter
		.then(({ highlight }) => coded.forEach(highlight))
		.catch(() => {
			// Plain code is still readable; try again on the next reply.
			highlighter = null;
		});
}

/** The text a code block's Copy button copies. */
export function codeText(button: Element): string {
	return button.closest(".code-block")?.querySelector("pre code")?.textContent ?? "";
}
