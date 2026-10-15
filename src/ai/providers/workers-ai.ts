/**
 * Workers AI provider: models on the owner's account, through the gateway.
 *
 * Returns the model's raw SSE bytes. Parsing and screening happen in
 * src/ai/stream.ts, which is shared with every other provider.
 */
import { ChatMessage, Env } from "../../types";
import { gatewayOptions } from "../gateway";
import { ModelSpec } from "../registry";
import { ChatRun, ProviderRequest } from "./types";

export async function runWorkersAi(env: Env, spec: ModelSpec, req: ProviderRequest): Promise<ChatRun> {
	if (spec.provider !== "workers-ai") {
		throw new Error(`Not a Workers AI model: ${spec.id}`);
	}

	const stream = await env.AI.run(
		spec.id as Parameters<Ai["run"]>[0],
		{
			messages: req.messages as ChatMessage[],
			max_tokens: req.maxTokens,
			stream: true,
		} as never,
		gatewayOptions(env, { route: req.route, model: spec.id }),
	);

	return { stream: stream as unknown as ReadableStream<Uint8Array>, spec };
}
