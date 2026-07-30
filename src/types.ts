/**
 * Type definitions for the EleenAI chat application.
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
	 * Binding for R2 Spline assets bucket.
	 */
	SPLINE_ASSETS: R2Bucket;

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

	/**
	 * Gemini API Key for image generation, vision, and grounding.
	 */
	GEMINI_API_KEY: string;

	/**
	 * KV Namespace for long-term memory
	 */
	ELEEN_MEMORY: KVNamespace;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/**
 * File attachment sent alongside a chat message.
 */
export interface Attachment {
	/** Base64-encoded file data */
	data: string;
	/** MIME type, e.g. "image/png", "application/pdf" */
	mimeType: string;
	/** Original filename */
	name: string;
}

/**
 * Shape of the POST body for /api/chat and /api/chat/guest.
 */
export interface ChatRequestBody {
	messages: ChatMessage[];
	attachments?: Attachment[];
	/** Response mode selected in the UI: "balanced" | "creative" | "logical". */
	mode?: string;
}
