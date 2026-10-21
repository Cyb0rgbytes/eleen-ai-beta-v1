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

/**
 * The wait for the first token: a skeleton shaped like the reply panel it
 * becomes (DESIGN.md principle 7), not a spinner. Same grid as an assistant
 * turn, so the reply replaces it without the layout moving.
 */
export function createThinking(): HTMLElement {
	const root = el("div", "thinking-indicator");
	root.setAttribute("role", "status");
	const panel = el("div", "skeleton-panel");
	for (const width of ["92%", "78%", "54%"]) {
		const line = el("div", "skeleton-line");
		line.style.inlineSize = width;
		panel.append(line);
	}
	const label = el("span", "sr-only");
	label.textContent = t("thinking");
	root.append(avatar(), panel, label);
	return root;
}

/** The wait for a generated image: a skeleton at the image's place and size. */
export function createImageSkeleton(prompt: string): HTMLElement {
	const root = el("div", "message assistant-message is-pending");
	root.setAttribute("role", "status");
	const body = el("div", "message-body");
	const frame = el("div", "skeleton-image");
	const caption = el("span", "chat-image-caption");
	caption.dir = "auto";
	caption.textContent = t("generatingImage");
	const label = el("span", "sr-only");
	label.textContent = prompt;
	body.append(frame, caption, label);
	root.append(avatar(), body);
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

/** The clean text of each finished reply, for Copy. Markers already stripped. */
export const replyText = new WeakMap<Element, string>();

const ACTIONS = {
	copy: { icon: "copy", label: "copy" },
	regenerate: { icon: "arrow-clockwise", label: "regenerate" },
	speak: { icon: "speaker-high", label: "speak" },
} as const;

function actionButton(kind: keyof typeof ACTIONS): HTMLButtonElement {
	const button = el("button", `message-action ${kind}-button`);
	button.type = "button";
	button.dataset.action = kind;
	button.append(icon(ACTIONS[kind].icon));
	const label = el("span", "sr-only");
	label.textContent = t(ACTIONS[kind].label);
	button.append(label);
	button.title = label.textContent;
	return button;
}

/**
 * The reasoning panel (DESIGN.md section 7): a disclosure at the top of the
 * reply, open with a live timer while the model thinks, collapsed to
 * "Thought for Ns" once the answer begins unless the reader opened it.
 * Only a v2 `reasoning` event creates one. The thinking is plain text.
 */
interface ReasoningPanel {
	readonly root: HTMLDetailsElement;
	push(text: string): void;
	/** The answer has begun, or the turn ended: stop the clock. */
	settle(): void;
}

function createReasoning(): ReasoningPanel {
	const root = el("details", "reasoning");
	root.open = true;
	const summary = el("summary", "reasoning-summary");
	const label = el("span", "reasoning-label");
	label.textContent = t("reasoningLive");
	// The ticking clock is for the eye; the live region would announce
	// every second otherwise. The settled label carries the duration.
	const clock = el("span", "reasoning-clock");
	clock.setAttribute("aria-hidden", "true");
	clock.textContent = "0s";
	summary.append(icon("caret-down"), label, clock);

	const body = el("div", "reasoning-text");
	body.dir = "auto";
	const text = document.createTextNode("");
	body.append(text);
	root.append(summary, body);

	const started = performance.now();
	const seconds = () => Math.max(1, Math.round((performance.now() - started) / 1000));
	const timer = setInterval(() => {
		clock.textContent = `${Math.floor((performance.now() - started) / 1000)}s`;
	}, 1000);
	let settled = false;
	let touched = false;
	summary.addEventListener("click", () => {
		touched = true;
	});

	return {
		root,
		push(chunk) {
			text.appendData(chunk);
		},
		settle() {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			clock.remove();
			label.textContent = t("reasoningDone", { seconds: seconds() });
			root.classList.add("is-done");
			if (!touched) root.open = false;
		},
	};
}

export interface AssistantView {
	readonly root: HTMLElement;
	/** Append chain-of-thought text (v2 `reasoning` events). */
	reason(text: string): void;
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
	// The accent rule pulses only while tokens are arriving (DESIGN.md 7):
	// each update re-arms a short timer, and a pause lets it settle.
	let receiving: ReturnType<typeof setTimeout> | undefined;
	const RECEIVING_MS = 500;

	function markReceiving() {
		root.classList.add("is-receiving");
		clearTimeout(receiving);
		receiving = setTimeout(() => root.classList.remove("is-receiving"), RECEIVING_MS);
	}

	function stopReceiving() {
		clearTimeout(receiving);
		root.classList.remove("is-receiving");
	}

	let reasoning: ReasoningPanel | null = null;

	function paint(raw: string, streaming: boolean): Extracted {
		const extracted = extractMarkers(raw, { streaming });
		const blocks = renderMarkdown(extracted.text);
		if (reasoning) {
			// The panel stays put: re-inserting it would restart its
			// animation and lose the reader's open or closed choice.
			while (reasoning.root.nextSibling) reasoning.root.nextSibling.remove();
			body.append(blocks);
		} else {
			body.replaceChildren(blocks);
		}
		return extracted;
	}

	return {
		root,
		reason(chunk) {
			if (!reasoning) {
				reasoning = createReasoning();
				body.prepend(reasoning.root);
			}
			reasoning.push(chunk);
			markReceiving();
		},
		update(raw) {
			reasoning?.settle();
			pending = raw;
			markReceiving();
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
			reasoning?.settle();

			const extracted = paint(raw, false);
			stopReceiving();
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

			replyText.set(root, extracted.text);
			const actions = el("div", "message-actions");
			const feedback = el("div", "message-feedback");
			const tools = el("div", "message-tools");
			if (extracted.text) tools.append(actionButton("copy"), actionButton("speak"));
			tools.append(actionButton("regenerate"));
			feedback.append(tools, feedbackButton("up"), feedbackButton("down"));
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
			reasoning?.settle();
			reasoning = null;
			stopReceiving();
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
