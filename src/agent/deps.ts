/**
 * The seam between the agent surfaces and the application's request handlers.
 *
 * The MCP endpoint needs to invoke the same logic that backs /api/chat and
 * friends. Importing those directly from src/index.ts would create a module
 * cycle (index -> router -> mcp -> index), which esbuild tolerates but whose
 * evaluation order is not something worth betting a deploy on.
 *
 * Passing them in instead costs a few lines and buys the indirection the MCP
 * tools want anyway: to re-point MCP at a different provider layer later, swap
 * the object, not the MCP code.
 */
import { Env } from "../types";

/** Signature of the streaming chat handler in src/index.ts. */
export type ChatHandler = (
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
	maxTokens: number,
) => Promise<Response>;

/** Signature shared by the image, vision and search handlers. */
export type SimpleHandler = (request: Request, env: Env) => Promise<Response>;

export interface AgentHandlers {
	chat: ChatHandler;
	image: SimpleHandler;
	vision: SimpleHandler;
	search: SimpleHandler;
}

/** Per-caller limits resolved from the presence of a valid bearer token. */
export interface Tier {
	userId: string;
	maxTokens: number;
	authenticated: boolean;
}

export const GUEST_TIER: Tier = {
	userId: "guest",
	maxTokens: 512,
	authenticated: false,
};
