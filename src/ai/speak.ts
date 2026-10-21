/**
 * Voice output: text to speech with Deepgram Aura on Workers AI.
 *
 * The browser posts the reply text it wants spoken and plays the MP3 that
 * comes back. Aura speaks English only; the client reads Arabic replies with
 * the browser's own voice and never calls this route for them.
 *
 * Aura is billed per character ($0.015 per 1,000 on the owner's account), so
 * the text is capped here and the route has its own rate-limit bucket.
 */
import { Env } from "../types";
import { gatewayOptions } from "./gateway";

const AURA_MODEL = "@cf/deepgram/aura-1";
const SPEAKER = "asteria";

/** About a minute of speech, and at most $0.0225 a call. */
export const MAX_SPEAK_CHARS = 1500;

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** The text to speak, or the error response to send instead. */
export async function readSpeakText(request: Request): Promise<string | Response> {
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
		return json({ error: "Send JSON: { \"text\": \"...\" }." }, 415);
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Malformed JSON." }, 400);
	}
	const text = (body as { text?: unknown } | null)?.text;
	if (typeof text !== "string" || !text.trim()) {
		return json({ error: "text must be a non-empty string." }, 422);
	}
	if (text.length > MAX_SPEAK_CHARS) {
		return json({ error: `text must be at most ${MAX_SPEAK_CHARS} characters.` }, 422);
	}
	return text.trim();
}

export async function handleSpeak(request: Request, env: Env): Promise<Response> {
	const text = await readSpeakText(request);
	if (text instanceof Response) return text;

	try {
		const upstream = await env.AI.run(
			AURA_MODEL,
			{ text, speaker: SPEAKER, encoding: "mp3" },
			{ ...gatewayOptions(env, { route: "speak" }), returnRawResponse: true },
		);
		if (!(upstream instanceof Response) || !upstream.ok || !upstream.body) {
			console.error("Speech failed:", upstream instanceof Response ? upstream.status : typeof upstream);
			return json({ error: "Could not speak the reply." }, 502);
		}
		return new Response(upstream.body, {
			headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
		});
	} catch (error) {
		console.error("Speech failed:", error);
		return json({ error: "Could not speak the reply." }, 502);
	}
}
