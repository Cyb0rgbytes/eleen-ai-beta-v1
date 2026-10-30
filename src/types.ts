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
	 * Private R2 bucket (`eleen-uploads`) for files users attach (M5.2).
	 * Every key is under u/{userId}/, so a lookup can only reach the
	 * caller's own objects (src/files/store.ts).
	 */
	UPLOADS: R2Bucket;

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
	 * The owner's fal key, for paid Studio generation only (src/media/fal.ts).
	 * Set via `wrangler secret put FAL_KEY`, and in `.dev.vars` locally. Never
	 * stored in the AI Gateway. Without it, fal calls fail before any request.
	 */
	FAL_KEY?: string;

	/**
	 * Private R2 bucket (`eleen-media`) for generated clips. Separate from
	 * UPLOADS so "Delete all conversations" can't remove paid media.
	 */
	MEDIA: R2Bucket;

	/** Signs media URLs (src/media/signed.ts). Without it, clips can't be served. */
	MEDIA_URL_KEY?: string;

	/** Who may use Studio: comma-separated Clerk ids. Empty turns it off for everyone. */
	STUDIO_USER_IDS?: string;

	/** Daily ceiling on provider spend, in millionths of a dollar (src/lib/spend.ts). */
	STUDIO_DAILY_SPEND_MICROS?: string;

	/**
	 * AI Gateway name. Every Workers AI call is routed through it for logging
	 * and the spend limit (src/ai/gateway.ts). Optional so a missing var
	 * degrades to direct calls rather than failing requests.
	 */
	AI_GATEWAY_ID?: string;

	/** "report" sends the CSP Report-Only; anything else enforces it (src/lib/security-headers.ts). */
	CSP_MODE?: string;

	/**
	 * Master key for users' stored provider keys: 32 random bytes, base64.
	 * Set via `wrangler secret put KEY_ENCRYPTION_KEY`. Without it the key
	 * store is unavailable and premium models stay locked (src/lib/keys.ts).
	 */
	KEY_ENCRYPTION_KEY?: string;

	/**
	 * Commit the running Worker was built from. Set per deploy by
	 * scripts/deploy.mjs (`--var BUILD_SHA:<sha>`) and reported by
	 * /api/v1/health so scripts/verify-deploy.mjs can check production.
	 */
	BUILD_SHA?: string;

	/**
	 * KV Namespace for long-term memory
	 */
	ELEEN_MEMORY: KVNamespace;

	/**
	 * D1 database (`eleen-db`). Schema lives in migrations/, applied with
	 * `npm run db:migrate:remote` before deploying code that needs it.
	 */
	DB: D1Database;

	/**
	 * Per-caller burst guard (Workers Rate Limiting). Optional so a missing
	 * binding degrades to the D1 quota alone rather than failing requests.
	 */
	BURST?: RateLimit;
}

// Request types live in src/shared/ so the browser can import them too.
export type { Attachment, ChatMessage, ChatRequestBody, ModelForbiddenBody, ResponseMode } from "./shared/chat";
