/**
 * Users' own provider API keys: encryption, storage, and a liveness check.
 *
 * The billing decision for M3.4 is that premium models run only on the
 * caller's own key. That key is the most sensitive thing this Worker handles,
 * so the rules are narrow:
 *
 *   - Encrypted at rest with AES-256-GCM under the Worker secret
 *     KEY_ENCRYPTION_KEY, a fresh 12-byte IV per row, and the provider name
 *     bound in as additional data so a ciphertext cannot be moved between
 *     providers.
 *   - Decrypted only on the request path that forwards it to the provider.
 *   - Never returned to a client, never logged, never in an error message.
 *     The only fragment ever shown is the last four characters.
 *   - Checked against the provider once, when stored, with the cheapest call
 *     each provider offers, so a typo is caught before a chat fails.
 *
 * `key_version` is stored with every row so a future master-key rotation can
 * re-encrypt rows instead of orphaning them.
 */
import { Env } from "../types";
import { Provider } from "../ai/registry";

export type KeyProvider = Exclude<Provider, "workers-ai">;

export const KEY_PROVIDERS: readonly KeyProvider[] = ["openai", "anthropic", "google", "deepseek"];

export function isKeyProvider(value: unknown): value is KeyProvider {
	return typeof value === "string" && (KEY_PROVIDERS as readonly string[]).includes(value);
}

/** The master key version rows are written under today. */
export const CURRENT_KEY_VERSION = 1;

export const MAX_KEY_CHARS = 512;

/**
 * Shape each provider's keys take. A loose check: it exists to catch pasting
 * the wrong provider's key or a stray space, not to be a specification.
 */
const KEY_SHAPES: Record<KeyProvider, RegExp> = {
	openai: /^sk-[A-Za-z0-9_-]{20,}$/,
	anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
	google: /^AIza[A-Za-z0-9_-]{30,}$/,
	deepseek: /^sk-[A-Za-z0-9]{20,}$/,
};

export function looksLikeKey(provider: KeyProvider, key: string): boolean {
	return key.length <= MAX_KEY_CHARS && KEY_SHAPES[provider].test(key);
}

export function last4(key: string): string {
	return key.slice(-4);
}

// ─── Crypto ──────────────────────────────────────────────────────────────────

export class KeyStoreUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KeyStoreUnavailable";
	}
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

async function masterKey(env: Env): Promise<CryptoKey> {
	const raw = env.KEY_ENCRYPTION_KEY;
	if (!raw) throw new KeyStoreUnavailable("KEY_ENCRYPTION_KEY is not set");

	let bytes: Uint8Array;
	try {
		bytes = fromBase64(raw.trim());
	} catch {
		throw new KeyStoreUnavailable("KEY_ENCRYPTION_KEY is not base64");
	}
	if (bytes.length !== 32) {
		throw new KeyStoreUnavailable("KEY_ENCRYPTION_KEY must be 32 bytes");
	}

	return crypto.subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Additional authenticated data: binds a ciphertext to its owner and provider. */
function aad(userId: string, provider: KeyProvider): Uint8Array {
	return new TextEncoder().encode(`eleenai:provider-key:v${CURRENT_KEY_VERSION}:${userId}:${provider}`);
}

export interface Sealed {
	ciphertext: string;
	iv: string;
	keyVersion: number;
}

export async function seal(env: Env, userId: string, provider: KeyProvider, plaintext: string): Promise<Sealed> {
	const key = await masterKey(env);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(userId, provider) as BufferSource },
		key,
		new TextEncoder().encode(plaintext),
	);
	return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv), keyVersion: CURRENT_KEY_VERSION };
}

export async function open(env: Env, userId: string, provider: KeyProvider, sealed: Sealed): Promise<string> {
	if (sealed.keyVersion !== CURRENT_KEY_VERSION) {
		throw new KeyStoreUnavailable(`No master key for version ${sealed.keyVersion}`);
	}
	const key = await masterKey(env);
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64(sealed.iv) as BufferSource, additionalData: aad(userId, provider) as BufferSource },
		key,
		fromBase64(sealed.ciphertext) as BufferSource,
	);
	return new TextDecoder().decode(decrypted);
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface StoredKeySummary {
	provider: KeyProvider;
	last4: string;
	createdAt: number;
	verifiedAt: number | null;
}

interface Row {
	provider: string;
	ciphertext: string;
	iv: string;
	key_version: number;
	last4: string;
	created_at: number;
	verified_at: number | null;
}

export async function listKeys(env: Env, userId: string): Promise<StoredKeySummary[]> {
	const { results } = await env.DB.prepare(
		"SELECT provider, last4, created_at, verified_at FROM provider_keys WHERE user_id = ?1 ORDER BY provider",
	)
		.bind(userId)
		.all<Pick<Row, "provider" | "last4" | "created_at" | "verified_at">>();

	return results.map((r) => ({
		provider: r.provider as KeyProvider,
		last4: r.last4,
		createdAt: r.created_at,
		verifiedAt: r.verified_at,
	}));
}

export async function storeKey(
	env: Env,
	userId: string,
	provider: KeyProvider,
	plaintext: string,
	verifiedAt: number | null,
): Promise<StoredKeySummary> {
	const sealed = await seal(env, userId, provider, plaintext);
	const now = Math.floor(Date.now() / 1000);

	await env.DB.prepare(
		`INSERT INTO provider_keys (user_id, provider, ciphertext, iv, key_version, last4, created_at, verified_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
		 ON CONFLICT (user_id, provider) DO UPDATE SET
		   ciphertext = excluded.ciphertext,
		   iv = excluded.iv,
		   key_version = excluded.key_version,
		   last4 = excluded.last4,
		   created_at = excluded.created_at,
		   verified_at = excluded.verified_at`,
	)
		.bind(userId, provider, sealed.ciphertext, sealed.iv, sealed.keyVersion, last4(plaintext), now, verifiedAt)
		.run();

	return { provider, last4: last4(plaintext), createdAt: now, verifiedAt };
}

export async function deleteKey(env: Env, userId: string, provider: KeyProvider): Promise<boolean> {
	const result = await env.DB.prepare("DELETE FROM provider_keys WHERE user_id = ?1 AND provider = ?2")
		.bind(userId, provider)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/** The decrypted key for a request, or null when the user has none. */
export async function loadKey(env: Env, userId: string, provider: KeyProvider): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT ciphertext, iv, key_version FROM provider_keys WHERE user_id = ?1 AND provider = ?2",
	)
		.bind(userId, provider)
		.first<Pick<Row, "ciphertext" | "iv" | "key_version">>();

	if (!row) return null;
	return open(env, userId, provider, { ciphertext: row.ciphertext, iv: row.iv, keyVersion: row.key_version });
}

// ─── Provider check ──────────────────────────────────────────────────────────

/**
 * The cheapest authenticated call each provider offers: a model listing.
 * None of these consume tokens. The key travels only in the header the
 * provider documents; nothing here logs the request.
 */
const CHECKS: Record<KeyProvider, (key: string) => { url: string; headers: Record<string, string> }> = {
	openai: (key) => ({ url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${key}` } }),
	anthropic: (key) => ({
		url: "https://api.anthropic.com/v1/models",
		headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
	}),
	google: (key) => ({
		url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
		headers: { "x-goog-api-key": key },
	}),
	deepseek: (key) => ({ url: "https://api.deepseek.com/models", headers: { Authorization: `Bearer ${key}` } }),
};

export type KeyCheck = { ok: true } | { ok: false; status: number; reason: "rejected" | "unreachable" };

export async function checkKey(provider: KeyProvider, key: string, fetcher: typeof fetch = fetch): Promise<KeyCheck> {
	const { url, headers } = CHECKS[provider](key);
	try {
		const response = await fetcher(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(8000),
		});
		if (response.ok) return { ok: true };
		// 401/403 are the provider saying no; anything else is their problem.
		const rejected = response.status === 401 || response.status === 403;
		return { ok: false, status: response.status, reason: rejected ? "rejected" : "unreachable" };
	} catch {
		return { ok: false, status: 0, reason: "unreachable" };
	}
}
