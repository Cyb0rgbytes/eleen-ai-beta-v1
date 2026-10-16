/**
 * Builds chat turns with DOM APIs. Nothing here assigns innerHTML; model
 * text reaches the page only through markdown.ts (allowlisted nodes) or as
 * textContent.
 *
 * Structure, unchanged from the classic page so the stylesheet and the
 * e2e specs still apply:
 *
 *   .message.user-message > p[dir=auto]
 *   .message.assistant-message
 *     .ai-avatar
 *     .message-body[dir=auto]       the panel
 *       ...markdown blocks
 *       .suggestion-chips > button.suggestion-chip
 *       .message-actions
 *         .message-feedback > button[data-feedback]
 *         .message-usage
 */
import { icon } from "../ui/icons";
import { t } from "../i18n";
import { extractMarkers, type Extracted } from "./markers";
import { renderMarkdown } from "./markdown";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

function avatar(): HTMLElement {
	const a = el("div", "ai-avatar");
	a.textContent = "E";
	a.setAttribute("aria-hidden", "true");
	return a;
}

export function createUserMessage(text: string): HTMLElement {
	const root = el("div", "message user-message");
	const p = el("p");
	p.dir = "auto";
	p.textContent = text;
	root.append(p);
	return root;
}

export function createThinking(): HTMLElement {
	const root = el("div", "thinking-indicator");
	root.setAttribute("role", "status");
	const dots = el("div", "thinking-dots");
	dots.append(el("div"), el("div"), el("div"));
	const label = el("span", "sr-only");
	label.textContent = t("thinking");
	root.append(avatar(), dots, label);
	return root;
}

function feedbackButton(kind: "up" | "down"): HTMLButtonElement {
	const button = el("button");
	button.type = "button";
	button.dataset.feedback = kind;
	button.append(icon(kind === "up" ? "thumbs-up" : "thumbs-down"));
	const label = el("span", "sr-only");
	label.textContent = t(kind === "up" ? "feedbackGood" : "feedbackBad");
	button.append(label);
	return button;
}

function chips(suggestions: string[]): HTMLElement | null {
	if (!suggestions.length) return null;
	const row = el("div", "suggestion-chips");
	for (const s of suggestions) {
		const chip = el("button", "suggestion-chip");
		chip.type = "button";
		chip.textContent = s;
		chip.dataset.suggestion = s;
		row.append(chip);
	}
	return row;
}

export interface AssistantView {
	readonly root: HTMLElement;
	/** Re-render from the full text so far. Batched to one paint per frame. */
	update(raw: string): void;
	/** Final render with chips, actions and usage. Returns what was extracted. */
	finish(raw: string, options?: { completionTokens?: number; stopped?: boolean }): Extracted;
	/** Replace the reply with a designed error state. */
	fail(message: string): void;
}

export function createAssistantMessage(): AssistantView {
	const root = el("div", "message assistant-message is-streaming");
	const body = el("div", "message-body");
	body.dir = "auto";
	root.append(avatar(), body);

	let pending: string | null = null;
	let frame = 0;

	function paint(raw: string, streaming: boolean): Extracted {
		const extracted = extractMarkers(raw, { streaming });
		body.replaceChildren(renderMarkdown(extracted.text));
		return extracted;
	}

	return {
		root,
		update(raw) {
			pending = raw;
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (pending !== null) paint(pending, true);
				pending = null;
			});
		},
		finish(raw, options = {}) {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
			pending = null;

			const extracted = paint(raw, false);
			root.classList.remove("is-streaming");
			if (!extracted.text && !options.stopped) {
				const p = el("p");
				p.textContent = t("emptyReply");
				body.append(p);
			}
			if (options.stopped) {
				const note = el("p", "message-note");
				note.textContent = t("stopped");
				body.append(note);
			}
			const row = chips(extracted.suggestions);
			if (row) body.append(row);

			const actions = el("div", "message-actions");
			const feedback = el("div", "message-feedback");
			feedback.append(feedbackButton("up"), feedbackButton("down"));
			actions.append(feedback);
			if (typeof options.completionTokens === "number") {
				const usage = el("span", "message-usage");
				usage.textContent = t("tokens", { count: options.completionTokens });
				actions.append(usage);
			}
			body.append(actions);
			return extracted;
		},
		fail(message) {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
			root.classList.remove("is-streaming");
			root.classList.add("is-error");
			const p = el("p", "message-error");
			p.setAttribute("role", "alert");
			p.append(icon("warning-circle"));
			const span = el("span");
			span.textContent = message;
			p.append(span);
			body.replaceChildren(p);
		},
	};
}

/** A generated image, shown as its own assistant turn. */
export function createImageMessage(src: string, prompt: string): HTMLElement {
	const root = el("div", "message assistant-message");
	const body = el("div", "message-body");
	const wrapper = el("div", "chat-image-wrapper");
	const img = el("img", "chat-image");
	// src is a blob: URL we created from the image endpoint's bytes, never a
	// model-written URL.
	img.src = src;
	img.alt = prompt;
	img.loading = "lazy";
	const caption = el("span", "chat-image-caption");
	caption.dir = "auto";
	caption.textContent = prompt;
	wrapper.append(img, caption);
	body.append(wrapper);
	root.append(avatar(), body);
	return root;
}

/** A plain assistant notice, such as the welcome or a rate-limit message. */
export function createNotice(lines: { text: string; emphasis?: boolean }[]): HTMLElement {
	const root = el("div", "message assistant-message");
	const body = el("div", "message-body");
	body.dir = "auto";
	for (const line of lines) {
		const p = el("p");
		if (line.emphasis) {
			const em = el("em");
			em.textContent = line.text;
			p.append(em);
		} else {
			p.textContent = line.text;
		}
		body.append(p);
	}
	root.append(avatar(), body);
	return root;
}
