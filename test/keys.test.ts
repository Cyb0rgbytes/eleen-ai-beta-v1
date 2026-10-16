import { describe, expect, it } from "vitest";
import {
	KeyStoreUnavailable,
	checkKey,
	isKeyProvider,
	last4,
	looksLikeKey,
	open,
	seal,
} from "../src/lib/keys";
import type { Env } from "../src/types";

function envWith(masterKey: string | undefined): Env {
	return { KEY_ENCRYPTION_KEY: masterKey } as unknown as Env;
}

function randomMaster(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes));
}

describe("seal / open", () => {
	const env = envWith(randomMaster());
	const key = "sk-ant-" + "a".repeat(40);

	it("round-trips a key", async () => {
		const sealed = await seal(env, "user_1", "anthropic", key);
		expect(sealed.ciphertext).not.toContain(key);
		expect(sealed.keyVersion).toBe(1);
		expect(await open(env, "user_1", "anthropic", sealed)).toBe(key);
	});

	it("uses a fresh IV every time", async () => {
		const a = await seal(env, "user_1", "anthropic", key);
		const b = await seal(env, "user_1", "anthropic", key);
		expect(a.iv).not.toBe(b.iv);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it("refuses a ciphertext moved to another user or provider", async () => {
		const sealed = await seal(env, "user_1", "anthropic", key);
		await expect(open(env, "user_2", "anthropic", sealed)).rejects.toThrow();
		await expect(open(env, "user_1", "openai", sealed)).rejects.toThrow();
	});

	it("refuses a tampered ciphertext", async () => {
		const sealed = await seal(env, "user_1", "anthropic", key);
		const bytes = Uint8Array.from(atob(sealed.ciphertext), (c) => c.charCodeAt(0));
		bytes[0] ^= 0xff;
		const tampered = { ...sealed, ciphertext: btoa(String.fromCharCode(...bytes)) };
		await expect(open(env, "user_1", "anthropic", tampered)).rejects.toThrow();
	});

	it("refuses to open under a different master key", async () => {
		const sealed = await seal(env, "user_1", "anthropic", key);
		await expect(open(envWith(randomMaster()), "user_1", "anthropic", sealed)).rejects.toThrow();
	});

	it("fails clearly when the master key is missing or malformed", async () => {
		await expect(seal(envWith(undefined), "u", "openai", "sk-x")).rejects.toBeInstanceOf(KeyStoreUnavailable);
		await expect(seal(envWith("not base64!!"), "u", "openai", "sk-x")).rejects.toBeInstanceOf(KeyStoreUnavailable);
		await expect(seal(envWith(btoa("short")), "u", "openai", "sk-x")).rejects.toBeInstanceOf(KeyStoreUnavailable);
	});

	it("refuses an unknown key version instead of guessing", async () => {
		const sealed = await seal(env, "user_1", "anthropic", key);
		await expect(open(env, "user_1", "anthropic", { ...sealed, keyVersion: 2 })).rejects.toBeInstanceOf(
			KeyStoreUnavailable,
		);
	});
});

describe("key shapes", () => {
	it("accepts the documented prefixes", () => {
		expect(looksLikeKey("openai", "sk-" + "x".repeat(40))).toBe(true);
		expect(looksLikeKey("anthropic", "sk-ant-" + "x".repeat(40))).toBe(true);
		expect(looksLikeKey("google", "AIza" + "x".repeat(35))).toBe(true);
		expect(looksLikeKey("deepseek", "sk-" + "x".repeat(32))).toBe(true);
	});

	it("rejects the wrong provider's key, whitespace, and oversized input", () => {
		expect(looksLikeKey("openai", "AIza" + "x".repeat(35))).toBe(false);
		expect(looksLikeKey("anthropic", "sk-" + "x".repeat(40))).toBe(false);
		expect(looksLikeKey("openai", "sk-" + "x".repeat(40) + " ")).toBe(false);
		expect(looksLikeKey("openai", "sk-" + "x".repeat(600))).toBe(false);
	});

	it("exposes only the last four characters", () => {
		expect(last4("sk-ant-abcdefgh1234")).toBe("1234");
	});

	it("knows its providers", () => {
		expect(isKeyProvider("openai")).toBe(true);
		expect(isKeyProvider("workers-ai")).toBe(false);
		expect(isKeyProvider(1)).toBe(false);
	});
});

describe("checkKey", () => {
	const key = "sk-" + "k".repeat(40);

	function fakeFetch(status: number, capture: { url?: string; headers?: HeadersInit }): typeof fetch {
		return (async (url: string | URL | Request, init?: RequestInit) => {
			capture.url = String(url);
			capture.headers = init?.headers;
			return new Response(null, { status });
		}) as typeof fetch;
	}

	it("accepts a 200 and sends the key only in the provider's header", async () => {
		const capture: { url?: string; headers?: HeadersInit } = {};
		expect(await checkKey("openai", key, fakeFetch(200, capture))).toEqual({ ok: true });
		expect(capture.url).toBe("https://api.openai.com/v1/models");
		expect(capture.url).not.toContain(key);
		expect((capture.headers as Record<string, string>).Authorization).toBe(`Bearer ${key}`);
	});

	it("reports a rejected key distinctly from an outage", async () => {
		expect(await checkKey("anthropic", key, fakeFetch(401, {}))).toEqual({ ok: false, status: 401, reason: "rejected" });
		expect(await checkKey("anthropic", key, fakeFetch(503, {}))).toEqual({
			ok: false,
			status: 503,
			reason: "unreachable",
		});
	});

	it("treats a network failure as unreachable, not as rejected", async () => {
		const failing = (async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		expect(await checkKey("google", key, failing)).toEqual({ ok: false, status: 0, reason: "unreachable" });
	});
});
