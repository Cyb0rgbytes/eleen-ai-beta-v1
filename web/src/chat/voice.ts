/**
 * Voice input: record, transcribe on the Worker with Whisper, send. A turn
 * asked this way is marked as voice, so its reply is kept short enough to
 * hear and, by default, read aloud (speak.ts).
 *
 * A finished recording is sent as soon as it is transcribed, together with
 * anything already typed in the composer (owner's decision, 2026-10-17:
 * pressing Send after speaking was one step too many). Escape while
 * recording cancels, so nothing is sent. If a reply is still streaming the
 * transcript waits in the composer instead. A transcript that is exactly a
 * command ("send", "new chat", or the Arabic equivalents) acts instead of
 * being sent as text.
 *
 * The microphone is released the moment recording stops, so the browser's
 * recording indicator goes off then rather than after the upload.
 */
import { ApiError, request } from "../api/client";
import { isSignedIn } from "../auth/clerk";
import { t } from "../i18n";
import { setIcon } from "../ui/icons";
import { showToast } from "../ui/toast";
import { createWaveformElement, startWaveform, type Waveform } from "./waveform";
import type { ChatApi } from "./controller";

const MAX_MS = 60_000;
/** First type the browser can record wins: WebM/Opus, or MP4 on Safari. */
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** Whole-transcript commands, matched after lowercasing and stripping punctuation. */
const COMMANDS: Record<string, "send" | "new-chat"> = {
	send: "send",
	"send it": "send",
	"أرسل": "send",
	"ارسل": "send",
	"إرسال": "send",
	"new chat": "new-chat",
	"محادثة جديدة": "new-chat",
};

type VoiceState = "idle" | "recording" | "transcribing";

interface Recording {
	recorder: MediaRecorder;
	stream: MediaStream;
	startedAt: number;
	cancelled: boolean;
	limit: ReturnType<typeof setTimeout>;
	tick: ReturnType<typeof setInterval>;
	wave: Waveform;
}

export function normaliseCommand(text: string): "send" | "new-chat" | null {
	const key = text.toLowerCase().replace(/[.,!?؟،]/g, "").replace(/\s+/g, " ").trim();
	return COMMANDS[key] ?? null;
}

export function initVoice(chat: ChatApi): void {
	const button = document.getElementById("mic-button") as HTMLButtonElement | null;
	const timer = document.getElementById("mic-timer");
	const input = document.getElementById("user-input") as HTMLTextAreaElement | null;
	if (!button || !input) return;

	if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
		button.hidden = true;
		return;
	}

	const label = button.querySelector("span");
	// The level meter sits just before the timer, inside the composer row.
	const waveEl = createWaveformElement();
	(timer ?? button).before(waveEl);
	let recording: Recording | null = null;
	let savedPlaceholder: string | null = null;

	function setState(state: VoiceState) {
		if (!button || !input) return;
		button.classList.toggle("recording", state === "recording");
		button.classList.toggle("transcribing", state === "transcribing");
		button.setAttribute("aria-pressed", String(state === "recording"));
		button.disabled = state === "transcribing";
		setIcon(button, state === "recording" ? "stop" : state === "transcribing" ? "circle-notch" : "microphone");
		const text = state === "recording" ? t("stopRecording") : state === "transcribing" ? t("transcribing") : t("recordVoice");
		if (label) label.textContent = text;
		button.title = text;

		if (timer) {
			timer.hidden = state !== "recording";
			if (state === "recording") timer.textContent = "0:00";
		}

		// controls.ts owns the placeholder; hold it while the mic is busy and
		// put back exactly what was there.
		if (state !== "idle") {
			savedPlaceholder ??= input.placeholder;
			input.dataset.held = "1";
			input.placeholder = state === "recording" ? t("listening") : `${t("transcribing")}...`;
		} else if (savedPlaceholder !== null) {
			input.placeholder = savedPlaceholder;
			savedPlaceholder = null;
			delete input.dataset.held;
		}
	}

	function updateTimer() {
		if (!timer || !recording) return;
		const seconds = Math.floor((Date.now() - recording.startedAt) / 1000);
		timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	}

	function applyTranscript(text: string) {
		if (!input) return;
		if (!text) {
			showToast(t("voiceEmpty"));
			return;
		}
		const command = normaliseCommand(text);
		if (command === "new-chat") {
			chat.clearChat({ confirm: false });
			showToast(t("newChatStarted"), "success", 2500);
			return;
		}
		if (command === "send") {
			if (input.value.trim()) void chat.sendMessage(undefined, { voice: true });
			else showToast(t("nothingToSend"));
			return;
		}
		// Joined to anything already typed, then sent as one message.
		input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
		input.dispatchEvent(new Event("input"));
		if (!chat.isProcessing()) {
			// Asked by voice: the reply is kept speakable and read aloud.
			void chat.sendMessage(undefined, { voice: true });
			return;
		}
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}

	async function finish(chunks: Blob[], mimeType: string, cancelled: boolean) {
		if (cancelled || !chunks.length) {
			setState("idle");
			return;
		}
		setState("transcribing");
		try {
			const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
			const authenticated = isSignedIn();
			const response = await request(authenticated ? "/api/voice/transcribe" : "/api/voice/transcribe/guest", {
				method: "POST",
				raw: { data: blob, type: blob.type.split(";")[0] || "application/octet-stream" },
				auth: authenticated,
				timeoutMs: 60_000,
			});
			const data = (await response.json()) as { text?: string };
			applyTranscript((data.text ?? "").trim());
		} catch (error) {
			showToast(error instanceof ApiError && error.kind === "rate-limited" ? t("voiceRateLimit") : t("voiceFailed"), "error");
		} finally {
			setState("idle");
		}
	}

	function stop({ cancel = false } = {}) {
		if (!recording) return;
		recording.cancelled = cancel;
		clearTimeout(recording.limit);
		clearInterval(recording.tick);
		recording.wave.stop();
		for (const track of recording.stream.getTracks()) track.stop();
		if (recording.recorder.state !== "inactive") recording.recorder.stop();
	}

	async function start() {
		if (chat.isProcessing()) return;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (error) {
			const blocked = error instanceof DOMException && error.name === "NotAllowedError";
			showToast(blocked ? t("voiceBlocked") : t("voiceUnsupported"), "error");
			return;
		}

		const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
		const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
		const chunks: Blob[] = [];
		recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size) chunks.push(event.data);
		});
		recorder.addEventListener("stop", () => {
			const cancelled = recording?.cancelled ?? false;
			recording = null;
			void finish(chunks, recorder.mimeType, cancelled);
		});

		recording = {
			recorder,
			stream,
			startedAt: Date.now(),
			cancelled: false,
			limit: setTimeout(() => stop(), MAX_MS),
			tick: setInterval(updateTimer, 250),
			wave: startWaveform(stream, waveEl),
		};
		recorder.start();
		setState("recording");
	}

	setState("idle");
	button.addEventListener("click", () => (recording ? stop() : void start()));
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && recording) stop({ cancel: true });
	});
}
