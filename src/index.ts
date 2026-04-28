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

// Model ID for Workers AI text model
// See: https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Model ID for Workers AI image generation
const IMAGE_MODEL_ID = "@cf/black-forest-labs/flux-1-schnell";

// Default system prompt with image generation capability
const SYSTEM_PROMPT = `You are a helpful, friendly assistant called EleenAI. Provide concise and accurate responses.

You have the ability to generate images. When the user asks you to create, generate, draw, design, make, paint, or produce any kind of image, picture, illustration, photo, artwork, or visual, you MUST respond with exactly this format:

[IMG_GEN]a detailed description of the image to generate[/IMG_GEN]

Include a brief friendly message before the tag. For example:
"Here's your image! [IMG_GEN]a majestic golden retriever sitting in a sunlit meadow with wildflowers, photorealistic, warm lighting[/IMG_GEN]"

Make the description inside the tag detailed and descriptive for best image quality. Always include style hints like "photorealistic", "digital art", "anime style", etc.

If the user is NOT asking for an image, respond normally without the tag.`;

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

		// --- Guest chat route: no auth required ---
		if (url.pathname === "/api/chat/guest") {
			if (request.method === "POST") {
				return handleChatRequest(request, env, "guest", 512);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		// --- Guest image generation: no auth required ---
		if (url.pathname === "/api/image/generate/guest") {
			if (request.method === "POST") {
				return handleImageGenerate(request, env);
			}
			return new Response("Method not allowed", { status: 405 });
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
				return handleChatRequest(request, env, userId, 1024);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		if (url.pathname === "/api/image/generate") {
			if (request.method === "POST") {
				return handleImageGenerate(request, env);
			}
			return new Response("Method not allowed", { status: 405 });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests.
 * `userId` is available for future personalization (e.g., per-user history).
 * `maxTokens` controls the response length (lower for guest users).
 */
async function handleChatRequest(
	request: Request,
	env: Env,
	userId: string,
	maxTokens: number = 1024,
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
				max_tokens: maxTokens,
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
/**
 * Handles image generation requests.
 * Uses Flux-1-Schnell for fast text-to-image generation.
 */
async function handleImageGenerate(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const { prompt } = (await request.json()) as { prompt: string };

		if (!prompt || prompt.trim().length === 0) {
			return new Response(
				JSON.stringify({ error: "Prompt is required" }),
				{
					status: 400,
					headers: { "content-type": "application/json" },
				},
			);
		}

		const result = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
			prompt: prompt.trim(),
			num_steps: 4,
		});

		// result is image bytes from the Flux model
		return new Response(result as ReadableStream, {
			headers: {
				"content-type": "image/png",
				"cache-control": "public, max-age=3600",
			},
		});
	} catch (error) {
		console.error("Error generating image:", error);
		return new Response(
			JSON.stringify({ error: "Failed to generate image" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}
