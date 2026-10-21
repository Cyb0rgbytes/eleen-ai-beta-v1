/**
 * Voice output: EleenAI reads a reply aloud.
 *
 * English goes to the Worker, which speaks it with Deepgram Aura and sends
 * back an MP3. Arabic, and English whenever Aura is unavailable or the
 * limit is reached, uses the browser's own voice: Workers AI has no Arabic
 * voice, and a reply should never go unspoken because one engine failed.
 *
 * Only one reply speaks at a time. Starting another, sending a message,
 * Stop or Escape silences the current one.
 *
 * When to speak is the reader's choice (the toggle in the composer): after
 * a question asked by voice (auto, the default), after every reply, or never.
 */
import { ApiError, request } from "../api/client";
import { isSignedIn } from "../auth/clerk";
import { t, type MessageKey } from "../i18n";
import { setIcon, type IconName } from "../ui/icons";
import { extractMarkers } from "./markers";

/** Matches the Worker's cap in src/ai/speak.ts. */
export const MAX_SPOKEN_CHARS = 1500;

const ARABIC = /[؀-ۿ]/;

export type VoiceOut = "auto" | "always" | "off";

const VOICE_OUT_KEY = "eleen:voice-out";
const VOICE_OUT_ORDER: VoiceOut[] = ["auto", "always", "off"];

export function getVoiceOut(): VoiceOut {
	try {
		const stored = localStorage.getItem(VOICE_OUT_KEY);
		if (stored === "auto" || stored === "always" || stored === "off") return stored;
	} catch {
		// Storage blocked: the default still works.
	}
	return "auto";
}

function setVoiceOut(value: VoiceOut): void {
	try {
		localStorage.setItem(VOICE_OUT_KEY, value);
	} catch {
		// Not remembered across visits; this visit still honours it.
	}
	current = value;
}

let current: VoiceOut | null = null;

/** Whether a finished reply should be read aloud on its own. */
export function shouldAutoSpeak(askedByVoice: boolean): boolean {
	const mode = current ?? getVoiceOut();
	return mode === "always" || (mode === "auto" && askedByVoice);
}

/**
 * The words to say for a reply: no markers, no markdown syntax, code and
 * URLs left on screen, cut at a sentence end under the cap.
 */
export function toSpeech(raw: string): string {
	const text = extractMarkers(raw, { streaming: false })
		.text.replace(/```[\s\S]*?(?:```|$)/g, " (code shown on screen) ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/^[ \t]*>?[ \t]*\[!\w+\][ \t]*$/gm, "")
		.replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*$/gm, "")
		.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
		.replace(/(\*\*|\*|~~)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
		.replace(/[ \t]*\|[ \t]*/g, ", ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{2,}/g, "\n")
		.trim();
	if (text.length <= MAX_SPOKEN_CHARS) return text;
	const cut = text.slice(0, MAX_SPOKEN_CHARS);
	const end = Math.max(...[". ", "! ", "? ", "؟ ", "\n"].map((mark) => cut.lastIndexOf(mark)));
	return (end > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, end + 1) : cut).trim();
}

export function isArabic(text: string): boolean {
	return ARABIC.test(text);
}

export interface SpeakHooks {
	onStart?(): void;
	/** Called once, whether it finished, failed or was stopped. */
	onEnd?(): void;
}

export interface Speaker {
	speak(raw: string, hooks?: SpeakHooks): Promise<void>;
	stop(): void;
}

export function createSpeaker(): Speaker {
	let audio: HTMLAudioElement | null = null;
	let objectUrl: string | null = null;
	let fetching: AbortController | null = null;
	let active: { id: number; hooks: SpeakHooks } | null = null;
	let nextId = 0;

	function release() {
		fetching?.abort();
		fetching = null;
		if (audio) {
			audio.onended = null;
			audio.onerror = null;
			audio.pause();
		}
		if (objectUrl) URL.revokeObjectURL(objectUrl);
		objectUrl = null;
		if ("speechSynthesis" in window) speechSynthesis.cancel();
	}

	function end(id: number) {
		if (active?.id !== id) return;
		const { hooks } = active;
		active = null;
		release();
		hooks.onEnd?.();
	}

	/** The browser's own voice, a sentence at a time (long utterances stall in Chrome). */
	function speakInBrowser(id: number, text: string): void {
		if (!("speechSynthesis" in window)) {
			end(id);
			return;
		}
		const lang = isArabic(text) ? "ar" : "en";
		const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
		const sentences = text.match(/[^.!?؟\n]+[.!?؟]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
		sentences.forEach((sentence, index) => {
			const utterance = new SpeechSynthesisUtterance(sentence);
			utterance.lang = lang === "ar" ? "ar-SA" : "en-US";
			if (voice) utterance.voice = voice;
			if (index === sentences.length - 1) {
				utterance.onend = () => end(id);
				utterance.onerror = () => end(id);
			}
			speechSynthesis.speak(utterance);
		});
	}

	async function speakWithAura(id: number, text: string): Promise<boolean> {
		fetching = new AbortController();
		try {
			const authenticated = isSignedIn();
			const response = await request(authenticated ? "/api/voice/speak" : "/api/voice/speak/guest", {
				method: "POST",
				body: { text },
				auth: authenticated,
				signal: fetching.signal,
				timeoutMs: 30_000,
			});
			const blob = await response.blob();
			if (active?.id !== id) return true;
			objectUrl = URL.createObjectURL(blob);
			audio ??= new Audio();
			audio.src = objectUrl;
			audio.onended = () => end(id);
			// Audio that will not decode still gets said, in the browser's voice.
			audio.onerror = () => {
				if (active?.id === id) speakInBrowser(id, text);
			};
			await audio.play();
			return true;
		} catch (error) {
			// Stopped on purpose: nothing more to say.
			if (active?.id !== id || (error instanceof ApiError && error.kind === "aborted")) return true;
			return false;
		} finally {
			fetching = null;
		}
	}

	function stop() {
		if (active) end(active.id);
		else release();
	}

	return {
		stop,
		async speak(raw, hooks = {}) {
			stop();
			const text = toSpeech(raw);
			if (!text) return;
			const id = ++nextId;
			active = { id, hooks };
			hooks.onStart?.();
			if (!isArabic(text) && (await speakWithAura(id, text))) return;
			if (active?.id === id) speakInBrowser(id, text);
		},
	};
}

const VOICE_OUT_VIEW: Record<VoiceOut, { icon: IconName; label: MessageKey }> = {
	auto: { icon: "waveform", label: "voiceOutAuto" },
	always: { icon: "speaker-high", label: "voiceOutAlways" },
	off: { icon: "speaker-slash", label: "voiceOutOff" },
};

/**
 * The composer toggle: when you speak, always, never. Turning it off also
 * silences a reply that is speaking now.
 */
export function initVoiceOutToggle(speaker: Speaker): void {
	const button = document.getElementById("voice-out-btn") as HTMLButtonElement | null;
	if (!button) return;
	const label = document.createElement("span");
	label.className = "voice-out-label";

	function render(mode: VoiceOut) {
		const view = VOICE_OUT_VIEW[mode];
		button!.replaceChildren(label);
		setIcon(button!, view.icon);
		label.textContent = t(view.label);
		button!.title = `${t("voiceOut")}: ${t(view.label)}`;
		button!.dataset.mode = mode;
	}

	render(getVoiceOut());
	button.addEventListener("click", () => {
		const mode = current ?? getVoiceOut();
		const next = VOICE_OUT_ORDER[(VOICE_OUT_ORDER.indexOf(mode) + 1) % VOICE_OUT_ORDER.length]!;
		setVoiceOut(next);
		if (next === "off") speaker.stop();
		render(next);
	});
}
