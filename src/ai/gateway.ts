/**
 * AI Gateway routing for Workers AI calls.
 *
 * Every `env.AI.run` goes through the gateway named in `AI_GATEWAY_ID`, so
 * the gateway's logging and daily spend limit cover all inference the owner
 * pays for. The AI binding authenticates to the gateway itself; the Worker
 * holds no gateway token.
 *
 * The gateway stores no provider keys. Premium providers are reached only with
 * a user's own key (M3.4), and a request without one must fail before any
 * provider call rather than fall back to an owner credential.
 *
 * Caching is skipped: chat is per-user and streamed, so a cache hit would only
 * ever replay someone else's answer.
 */
import { Env } from "../types";

export function gatewayOptions(env: Env, metadata?: Record<string, string>): AiOptions {
	if (!env.AI_GATEWAY_ID) return {};
	return {
		gateway: {
			id: env.AI_GATEWAY_ID,
			skipCache: true,
			...(metadata ? { metadata } : {}),
		},
	};
}
