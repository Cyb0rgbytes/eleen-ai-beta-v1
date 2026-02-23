/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
	/**
	 * Binding for the Workers AI API.
	 */
	AI: Ai;

	/**
	 * Binding for static assets.
	 */
	ASSETS: { fetch: (request: Request) => Promise<Response> };

	/**
	 * Clerk secret key for server-side session verification.
	 * Set via `wrangler secret put CLERK_SECRET_KEY` for production.
	 * Set in `.dev.vars` for local development.
	 */
	CLERK_SECRET_KEY: string;

	/**
	 * Clerk publishable key (safe to expose to the browser).
	 */
	CLERK_PUBLISHABLE_KEY: string;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
