/**
 * Short-lived signed URLs for generated media.
 *
 * <video> can't send a Bearer token and the API refuses cookies, so a media
 * URL carries its own proof: an HMAC over the job id and expiry, minted only
 * for the job's owner. Without MEDIA_URL_KEY nothing can be signed or verified.
 */
import { Env } from "../types";

export const MEDIA_FILE_PREFIX = "/api/media/file/";

/** Long enough to finish watching and seeking a clip. */
const LIFETIME_SECONDS = 60 * 60;

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const message = (jobId: string, expires: number) => new TextEncoder().encode(`${jobId}.${expires}`);

const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** A same-origin URL for the job's file, or null when no key is set. */
export async function signMediaUrl(env: Env, jobId: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string | null> {
	if (!env.MEDIA_URL_KEY) return null;
	const expires = nowSeconds + LIFETIME_SECONDS;
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(env.MEDIA_URL_KEY), message(jobId, expires));
	return `${MEDIA_FILE_PREFIX}${jobId}?exp=${expires}&sig=${toHex(signature)}`;
}

/** Whether this URL's signature is genuine and unexpired. crypto.subtle.verify compares in constant time. */
export async function verifyMediaUrl(env: Env, jobId: string, url: URL, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
	const expires = Number(url.searchParams.get("exp"));
	const signature = url.searchParams.get("sig") ?? "";
	if (!env.MEDIA_URL_KEY || !Number.isSafeInteger(expires) || expires <= nowSeconds) return false;
	if (!/^[0-9a-f]{64}$/.test(signature)) return false;
	const bytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) => parseInt(pair, 16));
	return crypto.subtle.verify("HMAC", await hmacKey(env.MEDIA_URL_KEY), bytes, message(jobId, expires));
}
