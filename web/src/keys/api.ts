/**
 * The browser's side of /api/v1/keys (M3.4 part two).
 *
 * A provider key passes through here exactly once, as the PUT body. It is
 * never returned, stored, logged, or put in an error: request() keeps bodies
 * out of ApiError by design, and nothing in this module keeps a reference to
 * the key after the call returns. The server only ever sends back the last
 * four characters.
 */
import type { Provider } from "../../../src/shared/models";
import { ApiError, request } from "../api/client";

export type KeyProvider = Exclude<Provider, "workers-ai">;

export const KEY_PROVIDERS: readonly KeyProvider[] = ["openai", "anthropic", "google", "deepseek"];

/** Brand names, which are not translated. */
export const PROVIDER_NAMES: Record<KeyProvider, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google",
	deepseek: "DeepSeek",
};

export interface StoredKey {
	provider: KeyProvider;
	last4: string;
	createdAt: number;
	verifiedAt: number | null;
}

export function isKeyProvider(value: unknown): value is KeyProvider {
	return typeof value === "string" && (KEY_PROVIDERS as readonly string[]).includes(value);
}

/** Keep only well-formed rows; anything else from the wire is dropped. */
function parseStored(value: unknown): StoredKey | null {
	if (typeof value !== "object" || value === null) return null;
	const row = value as Record<string, unknown>;
	if (!isKeyProvider(row.provider) || typeof row.last4 !== "string") return null;
	return {
		provider: row.provider,
		// Four characters is all the server keeps; never show more.
		last4: row.last4.slice(-4),
		createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
		verifiedAt: typeof row.verifiedAt === "number" ? row.verifiedAt : null,
	};
}

export async function listKeys(signal?: AbortSignal): Promise<StoredKey[]> {
	const response = await request("/api/v1/keys", { auth: true, signal, timeoutMs: 10_000 });
	const body = (await response.json()) as { keys?: unknown };
	return Array.isArray(body.keys) ? body.keys.map(parseStored).filter((k): k is StoredKey => k !== null) : [];
}

export type SaveResult =
	| { ok: true; stored: StoredKey; verified: boolean }
	| { ok: false; reason: "invalid" | "rejected" | "unavailable" | "failed" };

/** Store a key. Validation failures come back as a reason, never as the key. */
export async function saveKey(provider: KeyProvider, key: string): Promise<SaveResult> {
	try {
		// The provider check can take a few seconds.
		const response = await request("/api/v1/keys", { method: "PUT", body: { provider, key }, auth: true, timeoutMs: 20_000 });
		const body = (await response.json()) as Record<string, unknown>;
		const stored = parseStored(body);
		if (!stored) return { ok: false, reason: "failed" };
		return { ok: true, stored, verified: body.verified === true };
	} catch (error) {
		if (error instanceof ApiError) {
			// The server's 422 says which: "<provider> rejected this key"
			// after the provider refused it, otherwise a shape failure.
			if (error.status === 422) return { ok: false, reason: /rejected/i.test(error.message) ? "rejected" : "invalid" };
			if (error.status === 503) return { ok: false, reason: "unavailable" };
		}
		return { ok: false, reason: "failed" };
	}
}

export async function removeKey(provider: KeyProvider): Promise<boolean> {
	try {
		await request("/api/v1/keys", { method: "DELETE", body: { provider }, auth: true, timeoutMs: 10_000 });
		return true;
	} catch (error) {
		// Already gone counts as removed.
		return error instanceof ApiError && error.status === 404;
	}
}
