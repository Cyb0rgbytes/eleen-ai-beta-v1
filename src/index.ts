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

// Fallback image model when Gemini is unavailable
const FALLBACK_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

// Maximum size for stored memory profile (bytes)
const MAX_MEMORY_SIZE = 2048;

// Advanced System prompt with personality, memory, and multi-modal instructions
const SYSTEM_PROMPT = `You are EleenAI, an advanced, highly intelligent, and friendly AI assistant powered by CSECNIX Technologies.

CORE CAPABILITIES & PERSONALITY:
1. Tone Adaptation: Adjust your tone to match the user. Be professional, casual, or technical as appropriate. Always be concise but incredibly helpful.
2. Multi-turn Reasoning: Think step-by-step for complex queries. Reference previous parts of the conversation.
3. Graceful Fallback: If you don't know something, or cannot perform an action (like browsing the live internet or executing external code), state it clearly. Do not hallucinate.
4. Proactive Suggestions: Anticipate what the user might want next. At the end of your response, you can optionally provide 1-3 follow-up suggestions using the format: [SUGGEST]Option 1|Option 2[/SUGGEST].

RICH RESPONSES:
Use Markdown extensively! Use **bold** for emphasis, \`code\` for technical terms, and \`\`\`language blocks\`\`\` for code. Use bullet points and headers to make your responses scannable.

IMAGE GENERATION:
You have the ability to generate images. When the user asks you to create, generate, draw, design, make, paint, or produce any kind of image, picture, illustration, photo, artwork, or visual, you MUST respond with exactly this format:

[IMG_GEN]a detailed description of the image to generate[/IMG_GEN]

Include a brief friendly message before the tag. For example:
"Here's your image! [IMG_GEN]a majestic golden retriever sitting in a sunlit meadow with wildflowers, photorealistic, warm lighting[/IMG_GEN]"

Make the description inside the tag highly detailed and descriptive for best image quality. Always include style hints like "photorealistic", "digital art", "anime style", "cinematic lighting", etc.

If the user is NOT asking for an image, respond normally without the [IMG_GEN] tag.`;

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
				return handleChatRequest(request, env, ctx, "guest", 512);
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
				return handleChatRequest(request, env, ctx, userId, 1024);
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
 * `userId` is used for personalized memory across sessions.
 * `maxTokens` controls the response length.
 */
async function handleChatRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
	maxTokens: number = 1024,
): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// 1. Contextual Memory Injection
		let rawMemory = "";
		if (userId !== "guest" && env.ELEEN_MEMORY) {
			try {
				rawMemory = (await env.ELEEN_MEMORY.get(userId)) || "";
			} catch (e) {
				console.warn("Could not fetch memory for user", userId, e);
			}
		}

		// Build the memory context string that gets appended to the system prompt
		const memoryContext = rawMemory
			? `\n\nCONTEXT FROM PREVIOUS SESSIONS (DO NOT explicitly mention you are reading this unless relevant):\n${rawMemory}`
			: "";

		// Prepend system prompt only if not already present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT + memoryContext });
		}

		// 2. Run the AI Model
		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages,
				max_tokens: maxTokens,
				stream: true,
			},
		);

		// 3. Background Memory Update (Non-blocking)
		// Pass rawMemory (the clean KV value) so comparison works correctly
		if (userId !== "guest" && env.ELEEN_MEMORY) {
			ctx.waitUntil(updateMemory(env, userId, messages, rawMemory));
		}

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
 * Background task to update user's long-term memory in KV.
 * Runs via ctx.waitUntil() so it never blocks the response stream.
 *
 * @param rawMemory - The raw string stored in KV (without any prompt prefix).
 */
async function updateMemory(
	env: Env,
	userId: string,
	messages: ChatMessage[],
	rawMemory: string,
) {
	try {
		// Only consider the last few user/assistant turns
		const recentMessages = messages
			.filter(m => m.role !== "system")
			.slice(-4)
			.map(m => `${m.role.toUpperCase()}: ${m.content}`)
			.join("\n");

		if (!recentMessages.trim()) return;

		const summaryPrompt = `You are a memory manager for an AI assistant.
Current Memory Profile: ${rawMemory || "None"}
Recent Conversation:
${recentMessages}

Extract any NEW important facts about the user, their preferences, their name, or the core topics discussed.
Keep the profile extremely concise, bulleted, and in third-person.
If there is nothing new or important to add, output the Current Memory Profile exactly as is.`;

		const response = await env.AI.run(MODEL_ID, {
			messages: [{ role: "user", content: summaryPrompt }],
			max_tokens: 256,
		});

		const newMemory = (response as any).response;
		if (!newMemory || !newMemory.trim()) return;

		const trimmed = newMemory.trim();

		// Only write if the memory actually changed AND is within size limits
		if (trimmed !== rawMemory.trim() && trimmed.length <= MAX_MEMORY_SIZE) {
			await env.ELEEN_MEMORY.put(userId, trimmed);
		}
	} catch (e) {
		console.error("Memory update failed:", e);
	}
}

/**
 * Handles image generation requests.
 * Attempts to use Gemini 2.5 Flash, falls back to Flux-1-Schnell if Gemini fails or is unconfigured.
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
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}

		// Try Gemini first if API key is present
		if (env.GEMINI_API_KEY) {
			try {
				const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

				const geminiResponse = await fetch(geminiUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [{ parts: [{ text: `Generate a high quality, detailed image exactly as described: ${prompt.trim()}` }] }],
						generationConfig: {
							responseModalities: ["IMAGE"],
						},
					}),
				});

				if (geminiResponse.ok) {
					const data = await geminiResponse.json() as any;
					const parts = data.candidates?.[0]?.content?.parts;
					const imagePart = parts?.find((p: any) => p.inlineData);

					if (imagePart?.inlineData) {
						const base64Data = imagePart.inlineData.data;
						const mimeType = imagePart.inlineData.mimeType || "image/jpeg";

						// Convert base64 to binary ArrayBuffer
						const binaryString = atob(base64Data);
						const bytes = new Uint8Array(binaryString.length);
						for (let i = 0; i < binaryString.length; i++) {
							bytes[i] = binaryString.charCodeAt(i);
						}

						return new Response(bytes.buffer, {
							headers: {
								"content-type": mimeType,
								"cache-control": "public, max-age=3600",
							},
						});
					}
				} else {
					console.warn("Gemini API rejected request, falling back to Flux:", geminiResponse.status);
				}
			} catch (geminiError) {
				console.error("Gemini generation error:", geminiError);
				// Proceed to fallback
			}
		}

		// Fallback to Cloudflare Workers AI Flux-1-Schnell
		console.log("Using Flux-1-Schnell for image generation");
		const result = await env.AI.run(FALLBACK_IMAGE_MODEL, {
			prompt: prompt.trim(),
			num_steps: 4,
		});

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
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}
}
