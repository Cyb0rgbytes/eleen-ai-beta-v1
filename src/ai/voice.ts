/**
 * Voice input: speech to text with Whisper on Workers AI.
 *
 * The browser records with MediaRecorder and posts the raw audio here. The
 * transcript goes back to the composer for the user to read and edit — it is
 * never sent to the chat model automatically, so a misheard command cannot
 * act on its own.
 */
import { Env } from "../types";
import { gatewayOptions } from "./gateway";

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** ~60 s of Opus at browser defaults is well under this. */
export const MAX_AUDIO_BYTES = 1.5 * 1024 * 1024;

/** Matches validate.ts MAX_CONTENT_CHARS: a transcript must fit in a message. */
const MAX_TRANSCRIPT_CHARS = 8000;

/** Hints Whisper accepts that the UI offers. Anything else auto-detects. */
const LANGUAGE_HINTS = new Set(["en", "ar"]);

export type AudioFormat = "webm" | "ogg" | "mp4" | "wav" | "mp3";

/**
 * Identify the container from its first bytes. The Content-Type header is
 * the client's claim; the bytes are what Whisper will actually decode, so a
 * file that is not audio is refused before it costs inference.
 */
export function detectAudioFormat(bytes: Uint8Array): AudioFormat | null {
	const ascii = (start: number, text: string) =>
		bytes.length >= start + text.length &&
		[...text].every((ch, i) => bytes[start + i] === ch.charCodeAt(0));

	if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
		return "webm"; // EBML header: WebM/Matroska (Chrome, Firefox)
	}
	if (ascii(0, "OggS")) return "ogg";
	if (ascii(4, "ftyp")) return "mp4"; // Safari records audio/mp4
	if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
	if (ascii(0, "ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
		return "mp3";
	}
	return null;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export async function handleTranscribe(request: Request, env: Env): Promise<Response> {
	// Refuse an oversized upload before reading it, when the client says how
	// big it is. A chunked body has no length, so the read below checks too.
	const declared = Number(request.headers.get("content-length") || "0");
	if (declared > MAX_AUDIO_BYTES) {
		return json({ error: "Recording is too long. Keep it under a minute." }, 413);
	}

	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.length === 0) return json({ error: "No audio received." }, 422);
	if (bytes.length > MAX_AUDIO_BYTES) {
		return json({ error: "Recording is too long. Keep it under a minute." }, 413);
	}
	if (!detectAudioFormat(bytes)) {
		return json({ error: "Unsupported audio format." }, 415);
	}

	const lang = new URL(request.url).searchParams.get("lang");

	try {
		const result = await env.AI.run(WHISPER_MODEL, {
			audio: toBase64(bytes),
			...(lang && LANGUAGE_HINTS.has(lang) ? { language: lang } : {}),
			// Silence and room noise are where Whisper invents text; skip them.
			vad_filter: true,
		}, gatewayOptions(env, { route: "voice" }));

		const text = (result.text || "").trim().slice(0, MAX_TRANSCRIPT_CHARS);
		return json({ text, language: result.transcription_info?.language ?? null });
	} catch (error) {
		console.error("Transcription failed:", error);
		return json({ error: "Could not transcribe the recording." }, 502);
	}
}
