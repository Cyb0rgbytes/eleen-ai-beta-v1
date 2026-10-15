/**
 * Third-party providers (OpenAI, Anthropic, Google, DeepSeek) through the AI
 * Gateway, using the AI binding's unified `provider/model` ids.
 *
 * Billing rule, from the M3.4 decision: these models run only with the
 * caller's own key, which travels in the provider's auth header on each
 * request. The gateway stores no provider keys and has "Require provider
 * credentials" on, so a request that somehow arrived without a key would get
 * a 400 from the gateway rather than fall through to the owner's account.
 * This module refuses even earlier, before any call is made.
 *
 * Until the key store (M3.4 part two) exists no caller can supply a key, so
 * every call here ends in KeyRequiredError. The provider is wired now so the
 * registry, the models endpoint and the picker already know these models.
 */
import { Env } from "../../types";
import { gatewayOptions } from "../gateway";
import { ModelSpec, Provider } from "../registry";
import { ChatRun, KeyRequiredError, ProviderRequest } from "./types";

/** The header each provider expects its key in. */
const AUTH_HEADER: Record<Exclude<Provider, "workers-ai">, (key: string) => Record<string, string>> = {
	openai: (key) => ({ Authorization: `Bearer ${key}` }),
	deepseek: (key) => ({ Authorization: `Bearer ${key}` }),
	anthropic: (key) => ({ "x-api-key": key }),
	google: (key) => ({ "x-goog-api-key": key }),
};

export async function runGatewayCompat(env: Env, spec: ModelSpec, req: ProviderRequest): Promise<ChatRun> {
	if (spec.provider === "workers-ai") {
		throw new Error(`Not a third-party model: ${spec.id}`);
	}
	if (!req.userKey) {
		throw new KeyRequiredError(spec);
	}

	const options = gatewayOptions(env, { route: req.route, model: spec.id });
	const stream = await env.AI.run(
		spec.id as Parameters<Ai["run"]>[0],
		{
			messages: req.messages,
			max_tokens: req.maxTokens,
			stream: true,
		} as never,
		{
			...options,
			// The key goes to the provider via the gateway and is never logged
			// here: nothing in this module writes the request to console.
			extraHeaders: AUTH_HEADER[spec.provider](req.userKey),
		},
	);

	return { stream: stream as unknown as ReadableStream<Uint8Array>, spec };
}
