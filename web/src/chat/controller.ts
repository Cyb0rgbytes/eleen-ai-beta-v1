/**
 * The conversation: history, sending, stopping, images, feedback.
 *
 * Behaviour carried over from the classic chat.js, deliberately:
 * - History opens with the same assistant greeting and is bounded to 20
 *   turns, keeping the first.
 * - `/imagine <prompt>` goes straight to the image endpoint; an [IMG_GEN]
 *   marker in a reply does the same after the reply finishes.
 * - Feedback is folded into the rated reply's history text.
 * - `eleen:turn-complete` fires when a turn is fully rendered; WebMCP
 *   waits on it. `window.chat` keeps its shape for the same reason.
 *
 * New: the reply streams over protocol 2, Send becomes Stop, usage is
 * shown, errors get a designed state, and the selected mode is sent (the
 * classic page never sent it, so the mode pills did nothing).
 */
import type { ChatMessage, ResponseMode } from "../../../src/shared/chat";
import { ApiError, request, streamChat } from "../api/client";
import { isSignedIn, openSignIn } from "../auth/clerk";
import { t } from "../i18n";
import { setIcon } from "../ui/icons";
import { showToast } from "../ui/toast";
import {
	createAssistantMessage,
	createImageMessage,
	createImageSkeleton,
	createNotice,
	createThinking,
	createUserMessage,
	replyText,
} from "./render";
import { follow } from "./scroll";
import { createSpeaker, shouldAutoSpeak, type Speaker } from "./speak";

const MAX_HISTORY = 20;

export interface ChatControllerOptions {
	messages: HTMLElement;
	onBusyChange(busy: boolean): void;
	/** Builds the empty state shown before the first message and on a new chat. */
	emptyState(): HTMLElement;
}

export interface SendOptions {
	/** Asked by voice: the reply is kept speakable and, by default, read aloud. */
	voice?: boolean;
}

export interface ChatApi {
	sendMessage(text?: string, options?: SendOptions): Promise<void>;
	stop(): void;
	clearChat(options?: { confirm?: boolean }): boolean;
	regenerate(): Promise<void>;
	history(): ChatMessage[];
	isProcessing(): boolean;
	setMode(mode: ResponseMode): void;
	/** A tier name or model id from the picker, and its display label. */
	setModel(model: string, label: string): void;
	/** Reads replies aloud; shared with the composer's voice-out toggle. */
	readonly speaker: Speaker;
}

function greeting(): ChatMessage[] {
	return [{ role: "assistant", content: t("historyGreeting") }];
}

export function createChat(options: ChatControllerOptions): ChatApi {
	const { messages } = options;
	let history: ChatMessage[] = greeting();
	let busy = false;
	let mode: ResponseMode = "balanced";
	let model = "fast";
	let modelLabel = "";
	let controller: AbortController | null = null;
	const speaker = createSpeaker();

	/** Read one finished reply aloud, showing it on its Speak button. */
	function speakReply(reply: Element) {
		const text = replyText.get(reply);
		const button = reply.querySelector<HTMLButtonElement>(".speak-button");
		if (!text) return;
		const show = (speaking: boolean) => {
			reply.classList.toggle("is-speaking", speaking);
			if (!button) return;
			button.setAttribute("aria-pressed", String(speaking));
			setIcon(button, speaking ? "stop" : "speaker-high");
			const label = button.querySelector(".sr-only");
			if (label) label.textContent = t(speaking ? "stopSpeaking" : "speak");
			button.title = t(speaking ? "stopSpeaking" : "speak");
		};
		void speaker.speak(text, { onStart: () => show(true), onEnd: () => show(false) });
	}

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") speaker.stop();
	});

	function setBusy(next: boolean) {
		busy = next;
		options.onBusyChange(next);
	}

	function append(node: HTMLElement, { force = false } = {}) {
		messages.append(node);
		requestAnimationFrame(() => follow(messages, { force }));
	}

	function bound() {
		if (history.length > MAX_HISTORY) {
			const first = history[0];
			history = first ? [first, ...history.slice(-(MAX_HISTORY - 1))] : history.slice(-MAX_HISTORY);
		}
	}

	/** A designed notice for the failures a person can act on. */
	function failureNotice(error: unknown): HTMLElement | null {
		if (!(error instanceof ApiError)) return null;
		if (error.kind === "rate-limited") {
			const minutes = error.retryAfter ? Math.max(1, Math.ceil(error.retryAfter / 60)) : null;
			const node = createNotice([
				{ text: t("rateLimitTitle") },
				{ text: minutes ? t("errorRateLimit", { minutes }) : t("errorRateLimitSoon"), emphasis: true },
			]);
			node.classList.add("is-limit");
			if (!isSignedIn()) {
				const body = node.querySelector(".message-body");
				const button = document.createElement("button");
				button.type = "button";
				button.className = "auth-button primary-cta";
				const label = document.createElement("span");
				label.textContent = t("signIn");
				button.append(label);
				button.addEventListener("click", () => void openSignIn());
				body?.append(button);
			}
			return node;
		}
		return null;
	}

	function errorText(error: unknown): string {
		if (error instanceof ApiError) {
			if (error.kind === "network") return t("errorNetwork");
			if (error.kind === "timeout") return t("errorTimeout");
			if (error.kind === "forbidden") {
				const name = modelLabel || t("thisModel");
				return error.reason === "key-required"
					? t("errorKeyRequired", { model: name })
					: t("errorSignIn", { model: name });
			}
		}
		return t("errorGeneric");
	}

	async function generateImage(prompt: string): Promise<boolean> {
		// A skeleton where the image will appear, instead of a status line.
		const placeholder = createImageSkeleton(prompt);
		append(placeholder, { force: true });
		try {
			const authenticated = isSignedIn();
			const response = await request(authenticated ? "/api/image/generate" : "/api/image/generate/guest", {
				method: "POST",
				body: { prompt },
				auth: authenticated,
				timeoutMs: 90_000,
			});
			const url = URL.createObjectURL(await response.blob());
			placeholder.replaceWith(createImageMessage(url, prompt));
			return true;
		} catch (error) {
			const notice = failureNotice(error);
			if (notice) placeholder.replaceWith(notice);
			else {
				const view = createAssistantMessage();
				placeholder.replaceWith(view.root);
				view.fail(t("errorImage"));
			}
			return false;
		} finally {
			requestAnimationFrame(() => follow(messages));
		}
	}

	async function sendMessage(text?: string, { voice = false }: SendOptions = {}): Promise<void> {
		const input = document.getElementById("user-input") as HTMLTextAreaElement | null;
		const message = (text ?? input?.value ?? "").trim();
		if (!message || busy) return;

		speaker.stop();
		setBusy(true);
		messages.querySelector(".empty-state")?.remove();
		append(createUserMessage(message), { force: true });
		if (input && text === undefined) {
			input.value = "";
			input.dispatchEvent(new Event("input"));
		}
		history.push({ role: "user", content: message });

		if (message.toLowerCase().startsWith("/imagine ")) {
			try {
				const prompt = message.slice("/imagine ".length).trim();
				if (await generateImage(prompt)) history.push({ role: "assistant", content: `[Generated image: ${prompt}]` });
			} finally {
				bound();
				setBusy(false);
				document.dispatchEvent(new CustomEvent("eleen:turn-complete"));
			}
			return;
		}
		await runTurn({ voice });
	}

	/**
	 * Ask again for the newest reply: drop it from the page and the history,
	 * then stream a fresh one from the same conversation.
	 */
	async function regenerate(): Promise<void> {
		if (busy) return;
		const last = history.at(-1);
		if (last?.role !== "assistant" || history.length < 2) return;
		history.pop();
		const replies = messages.querySelectorAll(".assistant-message");
		replies[replies.length - 1]?.remove();
		speaker.stop();
		setBusy(true);
		await runTurn();
	}

	/** Stream one assistant turn from the current history. Owns busy and the turn-complete event. */
	async function runTurn({ voice = false }: SendOptions = {}): Promise<void> {
		const thinking = createThinking();
		append(thinking, { force: true });
		// Only the newest reply offers Regenerate.
		messages.querySelectorAll(".regenerate-button").forEach((b) => b.remove());

		try {
			controller = new AbortController();
			const view = createAssistantMessage();
			let raw = "";
			let completionTokens: number | undefined;
			let failed: string | null = null;
			let started = false;

			const begin = () => {
				if (started) return;
				started = true;
				thinking.replaceWith(view.root);
			};

			try {
				for await (const event of streamChat(
					{ messages: history, mode, model, ...(voice ? { voice: true } : {}) },
					{ authenticated: isSignedIn(), signal: controller.signal },
				)) {
					if (event.type === "reasoning") {
						begin();
						view.reason(event.data.text);
						requestAnimationFrame(() => follow(messages));
					} else if (event.type === "token") {
						begin();
						raw += event.data.text;
						view.update(raw);
						requestAnimationFrame(() => follow(messages));
					} else if (event.type === "usage") {
						completionTokens = event.data.completionTokens;
					} else if (event.type === "error") {
						failed = event.data.message;
					}
					// meta is not shown.
				}
			} catch (error) {
				if (!(error instanceof ApiError && error.kind === "aborted")) throw error;
			}

			const stopped = controller.signal.aborted;
			begin();
			if (failed !== null) {
				view.fail(failed);
			} else {
				const extracted = view.finish(raw, { completionTokens, stopped });
				if (raw.trim()) history.push({ role: "assistant", content: raw });
				if (!stopped && extracted.text && shouldAutoSpeak(voice)) speakReply(view.root);
				if (extracted.imagePrompt && !stopped) await generateImage(extracted.imagePrompt);
			}
			requestAnimationFrame(() => follow(messages));
		} catch (error) {
			thinking.remove();
			const notice = failureNotice(error);
			if (notice) {
				append(notice, { force: true });
			} else {
				const view = createAssistantMessage();
				append(view.root);
				view.fail(errorText(error));
			}
		} finally {
			controller = null;
			thinking.remove();
			bound();
			setBusy(false);
			document.dispatchEvent(new CustomEvent("eleen:turn-complete"));
		}
	}

	function stop() {
		controller?.abort();
		speaker.stop();
	}

	function clearChat({ confirm: ask = true } = {}): boolean {
		if (ask && !window.confirm(t("clearConfirm"))) return false;
		stop();
		history = greeting();
		messages.replaceChildren(options.emptyState());
		return true;
	}

	/** Fold a rating into the newest assistant turn, as the classic page did. */
	function rate(kind: "up" | "down") {
		for (let i = history.length - 1; i >= 0; i--) {
			const turn = history[i];
			if (turn?.role !== "assistant") continue;
			const base = turn.content.replace(/\n\n\[User rated this response as: (Good|Bad)\]$/, "");
			turn.content = `${base}\n\n[User rated this response as: ${kind === "up" ? "Good" : "Bad"}]`;
			break;
		}
	}

	// One delegated listener for everything rendered inside messages.
	messages.addEventListener("click", (event) => {
		if (!(event.target instanceof Element)) return;

		const chip = event.target.closest<HTMLElement>(".suggestion-chip, .prompt-card");
		if (chip) {
			void sendMessage(chip.dataset.suggestion ?? chip.dataset.prompt ?? "");
			return;
		}

		const feedback = event.target.closest<HTMLButtonElement>("[data-feedback]");
		if (feedback) {
			const group = feedback.parentElement;
			group?.querySelectorAll("button").forEach((b) => {
				b.classList.remove("active");
				b.setAttribute("aria-pressed", "false");
			});
			feedback.classList.add("active");
			feedback.setAttribute("aria-pressed", "true");
			rate(feedback.dataset.feedback === "up" ? "up" : "down");
			showToast(t("feedbackThanks"), "success", 2000);
			return;
		}

		const action = event.target.closest<HTMLButtonElement>("[data-action]");
		if (action) {
			const reply = action.closest(".assistant-message");
			if (action.dataset.action === "regenerate") {
				void regenerate();
			} else if (action.dataset.action === "copy" && reply) {
				void copyReply(action, replyText.get(reply) ?? "");
			} else if (action.dataset.action === "speak" && reply) {
				if (reply.classList.contains("is-speaking")) speaker.stop();
				else speakReply(reply);
			}
			return;
		}

		const image = event.target.closest<HTMLImageElement>(".chat-image");
		if (image) window.open(image.src, "_blank", "noopener");
	});

	/** Copy a reply's text; the icon morphs to a check and back (DESIGN.md 7). */
	async function copyReply(button: HTMLButtonElement, text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			showToast(t("copyFailed"), "error");
			return;
		}
		const label = button.querySelector(".sr-only");
		button.classList.add("is-done");
		setIcon(button, "check");
		if (label) label.textContent = t("copied");
		setTimeout(() => {
			button.classList.remove("is-done");
			setIcon(button, "copy");
			if (label) label.textContent = t("copy");
		}, 1500);
	}

	return {
		sendMessage,
		stop,
		clearChat,
		regenerate,
		history: () => history,
		isProcessing: () => busy,
		setMode: (next) => {
			mode = next;
		},
		setModel: (next, label) => {
			model = next;
			modelLabel = label;
		},
		speaker,
	};
}
