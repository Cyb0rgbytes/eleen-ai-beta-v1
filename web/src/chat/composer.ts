/**
 * The composer: textarea, Send that becomes Stop, enhance, mode pills.
 *
 * Send and Stop are one button (DESIGN.md section 7): while a reply
 * streams it shows the stop glyph, is labelled "Stop generating", and
 * aborts the request. Enter sends, Shift+Enter is a newline, Escape stops
 * a streaming reply.
 */
import type { ResponseMode } from "../../../src/shared/chat";
import { ApiError, request } from "../api/client";
import { t } from "../i18n";
import { setIcon } from "../ui/icons";
import { pressFeedback } from "../ui/motion";
import { showToast } from "../ui/toast";
import type { ChatApi } from "./controller";

const MODES: readonly ResponseMode[] = ["balanced", "creative", "logical"];

function autosize(input: HTMLTextAreaElement): void {
	input.style.blockSize = "auto";
	input.style.blockSize = `${input.scrollHeight}px`;
}

export interface Composer {
	setBusy(busy: boolean): void;
	/** Enable the controls. Called once auth has settled, whatever happened. */
	enable(): void;
}

export function initComposer(chat: ChatApi): Composer {
	const input = document.getElementById("user-input") as HTMLTextAreaElement;
	const send = document.getElementById("send-button") as HTMLButtonElement;
	const sendLabel = send.querySelector("span");
	const enhance = document.getElementById("enhance-btn") as HTMLButtonElement | null;
	let streaming = false;

	setIcon(send, "arrow-up");
	if (sendLabel) sendLabel.textContent = t("send");
	pressFeedback(send);

	input.addEventListener("input", () => autosize(input));
	autosize(input);

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			if (!streaming && !send.disabled) void chat.sendMessage();
		}
	});

	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && streaming) chat.stop();
	});

	// Send turns into Stop under the pointer, so a quick double-click would
	// otherwise abort the reply it just started.
	let busySince = 0;
	const STOP_GUARD_MS = 400;

	send.addEventListener("click", () => {
		if (streaming) {
			if (performance.now() - busySince > STOP_GUARD_MS) chat.stop();
		} else {
			void chat.sendMessage();
		}
	});

	// Mode pills: aria-pressed carries the state for assistive tech.
	const pills = [...document.querySelectorAll<HTMLButtonElement>(".mode-btn")];
	const MODE_LABEL = { balanced: "modeBalanced", creative: "modeCreative", logical: "modeLogical" } as const;
	for (const pill of pills) {
		pill.type = "button";
		pressFeedback(pill);
		const key = MODE_LABEL[pill.dataset.mode as ResponseMode];
		if (key) pill.textContent = t(key);
		pill.setAttribute("aria-pressed", String(pill.classList.contains("active")));
		pill.addEventListener("click", () => {
			const mode = pill.dataset.mode as ResponseMode | undefined;
			if (!mode || !MODES.includes(mode)) return;
			for (const p of pills) {
				const on = p === pill;
				p.classList.toggle("active", on);
				p.setAttribute("aria-pressed", String(on));
			}
			chat.setMode(mode);
		});
	}

	if (enhance) {
		enhance.replaceChildren();
		setIcon(enhance, "sparkle");
		const label = document.createElement("span");
		label.className = "sr-only";
		label.textContent = t("enhance");
		enhance.append(label);
		enhance.title = t("enhance");
		pressFeedback(enhance);
		enhance.addEventListener("click", async () => {
			const prompt = input.value.trim();
			if (!prompt) {
				showToast(t("enhanceEmpty"));
				return;
			}
			enhance.disabled = true;
			try {
				const response = await request("/api/enhance-prompt", { method: "POST", body: { prompt } });
				const { enhanced } = (await response.json()) as { enhanced?: string };
				if (enhanced) {
					input.value = enhanced;
					autosize(input);
					showToast(t("promptEnhanced"), "success", 2500);
				}
			} catch (error) {
				showToast(error instanceof ApiError && error.kind === "rate-limited" ? t("errorRateLimitSoon") : t("enhanceFailed"), "error");
			} finally {
				enhance.disabled = false;
			}
		});
	}

	return {
		setBusy(busy) {
			streaming = busy;
			if (busy) busySince = performance.now();
			send.classList.toggle("is-stop", busy);
			setIcon(send, busy ? "stop" : "arrow-up");
			if (sendLabel) sendLabel.textContent = busy ? t("stop") : t("send");
			send.title = busy ? t("stop") : t("send");
			// The textarea stays editable while streaming so the next message
			// can be drafted; only sending is held.
			if (!busy) setTimeout(() => input.focus(), 50);
		},
		enable() {
			input.disabled = false;
			send.disabled = false;
		},
	};
}
