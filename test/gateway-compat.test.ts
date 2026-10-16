/**
 * The premium path without spending anything: a fake AI binding records
 * exactly what the Worker would hand the AI Gateway, so the key's route into
 * `extraHeaders` is checked with no network call and no provider bill.
 *
 * What this cannot check is the far side: that the gateway forwards the
 * header and the provider accepts it. That needs one live call.
 *
 * The keys below are made-up strings in each provider's shape. Assertions
 * about them are booleans, so a failure never prints one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODELS, type ModelSpec } from "../src/ai/registry";
import { runGatewayCompat } from "../src/ai/providers/gateway-compat";
import { KeyRequiredError } from "../src/ai/providers/types";
import type { Env } from "../src/types";

const KEYS = {
	openai: "sk-" + "f".repeat(40),
	anthropic: "sk-ant-" + "f".repeat(40),
	google: "AIza" + "f".repeat(35),
	deepseek: "sk-" + "d".repeat(32),
} as const;

interface Recorded {
	model: string;
	input: Record<string, unknown>;
	options: { gateway?: { id: string; skipCache?: boolean; metadata?: Record<string, string> }; extraHeaders?: Record<string, string> };
}

function fakeEnv() {
	const calls: Recorded[] = [];
	const env = {
		AI_GATEWAY_ID: "eleenai-gateway",
		AI: {
			run: async (model: string, input: Record<string, unknown>, options: Recorded["options"]) => {
				calls.push({ model, input, options });
				return new ReadableStream();
			},
		},
	} as unknown as Env;
	return { env, calls };
}

function premium(provider: ModelSpec["provider"]): ModelSpec {
	const listed = MODELS.find((m) => m.billing === "user-key" && m.provider === provider);
	// Google and DeepSeek have no listed model yet; the header map covers them.
	return listed ?? { ...(MODELS.find((m) => m.billing === "user-key") as ModelSpec), id: `${provider}/test-model`, provider };
}

const request = (userKey?: string) => ({
	messages: [{ role: "user" as const, content: "hello" }],
	maxTokens: 256,
	route: "chat",
	userKey,
});

afterEach(() => vi.restoreAllMocks());

describe("a user's key on the way to the gateway", () => {
	it.each([
		["openai", "authorization", (k: string) => `Bearer ${k}`],
		["anthropic", "x-api-key", (k: string) => k],
		["google", "x-goog-api-key", (k: string) => k],
		["deepseek", "authorization", (k: string) => `Bearer ${k}`],
	] as const)("%s: travels only in its provider's auth header", async (provider, header, value) => {
		const { env, calls } = fakeEnv();
		const spec = premium(provider);
		await runGatewayCompat(env, spec, request(KEYS[provider]));

		expect(calls).toHaveLength(1);
		const call = calls[0] as Recorded;
		const headers = Object.fromEntries(Object.entries(call.options.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
		expect(Object.keys(headers)).toEqual([header]);
		expect(headers[header] === value(KEYS[provider]), "the header carries the key").toBe(true);

		// Through the named gateway, uncached, under the registry's id.
		expect(call.model).toBe(spec.id);
		expect(call.options.gateway?.id).toBe("eleenai-gateway");
		expect(call.options.gateway?.skipCache).toBe(true);
		expect(call.input.stream).toBe(true);
		expect(call.input.max_tokens).toBe(256);

		// Nowhere else: not in the body, not in the gateway's logged metadata.
		const elsewhere = JSON.stringify({ input: call.input, gateway: call.options.gateway });
		expect(elsewhere.includes(KEYS[provider]), "key outside the auth header").toBe(false);
	});

	it("refuses before any call when there is no key, so nothing reaches the owner's account", async () => {
		const { env, calls } = fakeEnv();
		await expect(runGatewayCompat(env, premium("anthropic"), request())).rejects.toBeInstanceOf(KeyRequiredError);
		expect(calls).toHaveLength(0);
	});

	it("never writes the key to the console", async () => {
		const lines: string[] = [];
		for (const level of ["log", "info", "warn", "error", "debug"] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				lines.push(args.map(String).join(" "));
			});
		}
		const { env } = fakeEnv();
		await runGatewayCompat(env, premium("openai"), request(KEYS.openai));
		expect(lines.join("\n").includes(KEYS.openai), "key in the console").toBe(false);
	});

	it("will not run a Workers AI model through this path", async () => {
		const { env, calls } = fakeEnv();
		const owner = MODELS.find((m) => m.billing === "owner") as ModelSpec;
		await expect(runGatewayCompat(env, owner, request(KEYS.openai))).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});
