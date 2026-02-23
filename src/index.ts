/**
 * EleenAI - LLM Chat Application
 *
 * Powered by Cloudflare Workers AI.
 * Authentication is handled by Clerk (https://clerk.com).
 *
 * @license MIT
 */
import { createClerkClient } from "@clerk/backend";
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// See: https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Default system prompt
const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

export default {
	/**
	 * Main request handler for the Worker.
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Serve static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// --- Auth Guard: verify Clerk session for all /api/ routes ---
		const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

		// authenticateRequest checks Authorization header (Bearer token from Clerk)
		// and Clerk session cookies. It is the recommended approach for edge runtimes.
		const authState = await clerk.authenticateRequest(request, {
			secretKey: env.CLERK_SECRET_KEY,
			publishableKey: env.CLERK_PUBLISHABLE_KEY,
		});

		if (!authState.isSignedIn) {
			return new Response(
				JSON.stringify({ error: "Unauthorized: Please sign in." }),
				{
					status: 401,
					headers: {
						"content-type": "application/json",
						// Include Clerk's handshake headers if any are needed for redirection
						...Object.fromEntries(authState.headers),
					},
				},
			);
		}

		// Extract the authenticated user's ID
		const { userId } = authState.toAuth();

		// --- Authenticated API Routes ---
		if (url.pathname === "/api/chat") {
			if (request.method === "POST") {
				return handleChatRequest(request, env, userId);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests.
 * `userId` is available for future personalization (e.g., per-user history).
 */
async function handleChatRequest(
	request: Request,
	env: Env,
	userId: string,
): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// Prepend system prompt only if not already present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages,
				max_tokens: 1024,
				stream: true,
			},
		);

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}
