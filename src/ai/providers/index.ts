/**
 * Pick the provider for a model and run it.
 */
import { Env } from "../../types";
import { ModelSpec } from "../registry";
import { runGatewayCompat } from "./gateway-compat";
import { ChatRun, ProviderRequest } from "./types";
import { runWorkersAi } from "./workers-ai";

export { KeyRequiredError } from "./types";
export type { ChatRun, ProviderRequest } from "./types";

export function runChat(env: Env, spec: ModelSpec, req: ProviderRequest): Promise<ChatRun> {
	return spec.provider === "workers-ai" ? runWorkersAi(env, spec, req) : runGatewayCompat(env, spec, req);
}
