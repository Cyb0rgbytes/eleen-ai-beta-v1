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
import { showToast } from "../ui/toast";
import { createAssistantMessage, createImageMessage, createNotice, createThinking, createUserMessage } from "./render";
import { follow } from "./scroll";

const MAX_HISTORY = 20;

export interface ChatControllerOptions {
	messages: HTMLElement;
	/** The status line above the composer, used for image generation. */
	status: HTMLElement | null;
	onBusyChange(busy: boolean): void;
}

export interface ChatApi {
	sendMessage(text?: string): Promise<void>;
	stop(): void;
	clearChat(options?: { confirm?: boolean }): boolean;
	history(): ChatMessage[];
	isProcessing(): boolean;
	setMode(mode: ResponseMode): void;
}

function greeting(): ChatMessage[] {
	return [{ role: "assistant", content: t("historyGreeting") }];
}

export function createChat(options: ChatControllerOptions): ChatApi {
	const { messages, status } = options;
	let history: ChatMessage[] = greeting();
	let busy = false;
	let mode: ResponseMode = "balanced";
	let controller: AbortController | null = null;

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

	function showStatus(text: string | null) {
		if (!status) return;
		status.textContent = text ?? "";
		status.classList.toggle("visible", text !== null);
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
				button.addEventListener("click", openSignIn);
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
				const model = t("thisModel");
				return error.reason === "key-required" ? t("errorKeyRequired", { model }) : t("errorSignIn", { model });
			}
		}
		return t("errorGeneric");
	}

	async function generateImage(prompt: string): Promise<boolean> {
		showStatus(t("generatingImage"));
		try {
			const authenticated = isSignedIn();
			const response = await request(authenticated ? "/api/image/generate" : "/api/image/generate/guest", {
				method: "POST",
				body: { prompt },
				auth: authenticated,
				timeoutMs: 90_000,
			});
			const url = URL.createObjectURL(await response.blob());
			append(createImageMessage(url, prompt));
			return true;
		} catch (error) {
			const notice = failureNotice(error);
			if (notice) append(notice, { force: true });
			else {
				const view = createAssistantMessage();
				append(view.root);
				view.fail(t("errorImage"));
			}
			return false;
		} finally {
			showStatus(null);
		}
	}

	async function sendMessage(text?: string): Promise<void> {
		const input = document.getElementById("user-input") as HTMLTextAreaElement | null;
		const message = (text ?? input?.value ?? "").trim();
		if (!message || busy) return;

		setBusy(true);
		const thinking = createThinking();
		append(createUserMessage(message), { force: true });
		append(thinking, { force: true });
		if (input && text === undefined) {
			input.value = "";
			input.dispatchEvent(new Event("input"));
		}
		history.push({ role: "user", content: message });

		try {
			if (message.toLowerCase().startsWith("/imagine ")) {
				thinking.remove();
				const prompt = message.slice("/imagine ".length).trim();
				if (await generateImage(prompt)) history.push({ role: "assistant", content: `[Generated image: ${prompt}]` });
				return;
			}

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
					{ messages: history, mode },
					{ authenticated: isSignedIn(), signal: controller.signal },
				)) {
					if (event.type === "token") {
						begin();
						raw += event.data.text;
						view.update(raw);
						requestAnimationFrame(() => follow(messages));
					} else if (event.type === "usage") {
						completionTokens = event.data.completionTokens;
					} else if (event.type === "error") {
						failed = event.data.message;
					}
					// reasoning events are kept for the M3.6 panel; meta is not shown.
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
	}

	function clearChat({ confirm: ask = true } = {}): boolean {
		if (ask && !window.confirm(t("clearConfirm"))) return false;
		stop();
		history = [{ role: "assistant", content: t("chatCleared") }];
		messages.replaceChildren(createNotice([{ text: t("chatCleared") }]));
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

		const chip = event.target.closest<HTMLElement>(".suggestion-chip");
		if (chip) {
			void sendMessage(chip.dataset.suggestion ?? "");
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

		const image = event.target.closest<HTMLImageElement>(".chat-image");
		if (image) window.open(image.src, "_blank", "noopener");
	});

	return {
		sendMessage,
		stop,
		clearChat,
		history: () => history,
		isProcessing: () => busy,
		setMode: (next) => {
			mode = next;
		},
	};
}
