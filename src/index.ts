/**
 * EleenAI - Advanced Multimodal AI Chat Application
 *
 * Powered by Cloudflare Workers AI + Gemini API.
 * Authentication is handled by Clerk (https://clerk.com).
 *
 * Features:
 *  - Streaming SSE chat via Workers AI (Llama 3.1)
 *  - Image generation via Gemini 2.0 Flash / Flux-1-Schnell fallback
 *  - Vision analysis via Gemini (image understanding)
 *  - Web search grounding via Gemini Google Search
 *  - Long-term memory via KV
 *  - Multimodal file attachments (images, documents)
 *
 * @license MIT
 */
import { createClerkClient } from "@clerk/backend";
import { Env, ChatMessage, ChatRequestBody, Attachment } from "./types";

// ─── Model Configuration ─────────────────────────────────────────────────────

/** Workers AI text model */
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** Fallback image generation model */
const FALLBACK_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/** Maximum size for stored memory profile (bytes) */
const MAX_MEMORY_SIZE = 2048;

/** Gemini API base URL */
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are EleenAI, an advanced, highly intelligent AI assistant powered by CSECNIX Technologies.

CORE IDENTITY:
You are a next-generation multimodal AI assistant. You can understand text, analyze images and documents, generate images, and search the web for real-time information when needed.

REASONING & INTELLIGENCE:
1. For complex questions, think step by step. Break the problem down before answering.
2. Before giving a final answer, verify your reasoning. If you spot an error, correct it.
3. For math or logic problems, show your work clearly.
4. When uncertain, say so. Never fabricate information.
5. Reference previous messages in the conversation for continuity.

TONE & COMMUNICATION:
1. Adapt your tone to match the user — professional, casual, or technical as appropriate.
2. Be concise but thorough. Prefer clarity over verbosity.
3. Use Markdown for rich formatting: **bold**, \`code\`, \`\`\`code blocks\`\`\`, bullet points, and headers.

IMAGE GENERATION:
When the user asks to create, generate, draw, design, or produce any visual content, respond with:
[IMG_GEN]a detailed description of the image to generate[/IMG_GEN]
Include a brief friendly message before the tag. Make descriptions highly detailed with style hints (photorealistic, digital art, cinematic lighting, etc).

MULTIMODAL ANALYSIS:
When the user uploads an image or document, analyze it thoroughly:
- For images: describe what you see, identify objects, text, people, scenes, and provide insights.
- For documents: summarize key points, extract important data, and answer questions about the content.

WEB SEARCH GROUNDING:
When your response includes information from web search, cite your sources clearly using markdown links.

FOLLOW-UP SUGGESTIONS:
At the end of responses, optionally provide 1-3 follow-up suggestions:
[SUGGEST]Option 1|Option 2|Option 3[/SUGGEST]

TOOL STATUS INDICATORS:
When performing special operations, include these markers at the START of your response:
- [TOOL:think] — when doing complex reasoning
- [TOOL:search] — when using web search
- [TOOL:vision] — when analyzing an image
- [TOOL:generate] — when generating an image`;

// ─── Main Worker Handler ─────────────────────────────────────────────────────

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// ── Serve R2 Assets (Spline) ─────────────────────────────────────
		if (url.hostname === "assets.eleenai.xyz" || url.pathname.endsWith(".splinecode")) {
			if (request.method === "OPTIONS") {
				return new Response(null, {
					headers: {
						"Access-Control-Allow-Origin": "*",
						"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
						"Access-Control-Allow-Headers": "*",
						"Access-Control-Max-Age": "86400",
					}
				});
			}

			if (request.method !== "GET" && request.method !== "HEAD") {
				return new Response("Method not allowed", { status: 405 });
			}

			const objectKey = url.pathname.slice(1);
			const object = await env.SPLINE_ASSETS.get(objectKey);

			if (!object) {
				return new Response("Object Not Found", { status: 404 });
			}

			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set("etag", object.httpEtag);
			headers.set("Access-Control-Allow-Origin", "*");
			headers.set("Cache-Control", "public, max-age=31536000"); // Cache for 1 year

			return new Response(object.body, { headers });
		}

		// Serve static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// ── Guest Routes (no auth) ───────────────────────────────────────
		if (url.pathname === "/api/chat/guest" && request.method === "POST") {
			return handleChatRequest(request, env, ctx, "guest", 512);
		}

		if (url.pathname === "/api/image/generate/guest" && request.method === "POST") {
			return handleImageGenerate(request, env);
		}

		if (url.pathname === "/api/vision/analyze/guest" && request.method === "POST") {
			return handleVisionAnalysis(request, env);
		}

		if (url.pathname === "/api/search/ground/guest" && request.method === "POST") {
			return handleWebSearch(request, env);
		}

		// ── Auth Guard ───────────────────────────────────────────────────
		const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
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
						...Object.fromEntries(authState.headers),
					},
				},
			);
		}

		const { userId } = authState.toAuth();

		// ── Authenticated Routes ─────────────────────────────────────────
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleChatRequest(request, env, ctx, userId, 1024);
		}

		if (url.pathname === "/api/image/generate" && request.method === "POST") {
			return handleImageGenerate(request, env);
		}

		if (url.pathname === "/api/vision/analyze" && request.method === "POST") {
			return handleVisionAnalysis(request, env);
		}

		if (url.pathname === "/api/search/ground" && request.method === "POST") {
			return handleWebSearch(request, env);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// ─── Chat Handler ────────────────────────────────────────────────────────────

async function handleChatRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	userId: string,
	maxTokens: number = 1024,
): Promise<Response> {
	try {
		const body = (await request.json()) as ChatRequestBody;
		const messages = body.messages || [];
		const attachments = body.attachments || [];

		// 1. Contextual Memory Injection
		let rawMemory = "";
		if (userId !== "guest" && env.ELEEN_MEMORY) {
			try {
				rawMemory = (await env.ELEEN_MEMORY.get(userId)) || "";
			} catch (e) {
				console.warn("Could not fetch memory for user", userId, e);
			}
		}

		const memoryContext = rawMemory
			? `\n\nCONTEXT FROM PREVIOUS SESSIONS (DO NOT explicitly mention you are reading this unless relevant):\n${rawMemory}`
			: "";

		// 2. Process Attachments — inject descriptions into the conversation
		if (attachments.length > 0 && env.GEMINI_API_KEY) {
			for (const attachment of attachments) {
				try {
					const description = await analyzeAttachment(env, attachment);
					if (description) {
						// Insert the analysis right before the last user message
						const lastUserIdx = messages.length - 1;
						messages.splice(lastUserIdx, 0, {
							role: "system",
							content: `[The user attached a file: "${attachment.name}" (${attachment.mimeType})]\nAnalysis: ${description}`,
						});
					}
				} catch (e) {
					console.warn("Attachment analysis failed:", e);
				}
			}
		}

		// 3. Prepend system prompt
		if (!messages.some((msg) => msg.role === "system" && msg.content.includes("EleenAI"))) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT + memoryContext });
		}

		// 4. Run the AI Model
		const stream = await env.AI.run(MODEL_ID, {
			messages,
			max_tokens: maxTokens,
			stream: true,
		});

		// 5. Background Memory Update (Non-blocking)
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
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}
}

// ─── Attachment Analyzer ─────────────────────────────────────────────────────

async function analyzeAttachment(env: Env, attachment: Attachment): Promise<string> {
	if (!env.GEMINI_API_KEY) throw new Error("No Gemini API key");

	const isImage = attachment.mimeType.startsWith("image/");
	const geminiUrl = `${GEMINI_API_BASE}/models/gemini-2.0-flash-exp:generateContent?key=${env.GEMINI_API_KEY}`;

	if (isImage) {
		const response = await fetch(geminiUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{
					parts: [
						{ text: "Analyze this image in detail. Describe what you see, identify any text, objects, people, and provide relevant context." },
						{ inlineData: { mimeType: attachment.mimeType, data: attachment.data } },
					],
				}],
				generationConfig: { maxOutputTokens: 512 },
			}),
		});

		if (!response.ok) throw new Error(`Gemini vision failed: ${response.status}`);

		const data = (await response.json()) as any;
		return data.candidates?.[0]?.content?.parts?.[0]?.text || "Could not analyze image.";
	}

	// For text-based documents, decode and summarize
	try {
		const textContent = atob(attachment.data);
		const truncated = textContent.substring(0, 4000); // Cap at 4KB for context
		return `Document content (first 4000 chars):\n${truncated}`;
	} catch {
		return "Could not read document content.";
	}
}

// ─── Memory Manager ──────────────────────────────────────────────────────────

async function updateMemory(
	env: Env,
	userId: string,
	messages: ChatMessage[],
	rawMemory: string,
) {
	try {
		const recentMessages = messages
			.filter((m) => m.role !== "system")
			.slice(-4)
			.map((m) => `${m.role.toUpperCase()}: ${m.content}`)
			.join("\n");

		if (!recentMessages.trim()) return;

		const summaryPrompt = `You are a memory manager for an AI assistant.
Current Memory Profile: ${rawMemory || "None"}
Recent Conversation:
${recentMessages}

Extract any NEW important facts about the user: their name, preferences, interests, location, profession, communication style, and key topics discussed.
Keep the profile extremely concise, bulleted, and in third-person.
If there is nothing new or important to add, output the Current Memory Profile exactly as is.`;

		const response = await env.AI.run(MODEL_ID, {
			messages: [{ role: "user", content: summaryPrompt }],
			max_tokens: 256,
		});

		const newMemory = (response as any).response;
		if (!newMemory || !newMemory.trim()) return;

		const trimmed = newMemory.trim();
		if (trimmed !== rawMemory.trim() && trimmed.length <= MAX_MEMORY_SIZE) {
			await env.ELEEN_MEMORY.put(userId, trimmed);
		}
	} catch (e) {
		console.error("Memory update failed:", e);
	}
}

// ─── Image Generation ────────────────────────────────────────────────────────

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
				const geminiUrl = `${GEMINI_API_BASE}/models/gemini-2.0-flash-exp:generateContent?key=${env.GEMINI_API_KEY}`;

				const geminiResponse = await fetch(geminiUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [{ parts: [{ text: `Generate a high quality, detailed image exactly as described: ${prompt.trim()}` }] }],
						generationConfig: {
							responseModalities: ["IMAGE", "TEXT"],
						},
					}),
				});

				if (geminiResponse.ok) {
					const data = (await geminiResponse.json()) as any;
					const parts = data.candidates?.[0]?.content?.parts;
					const imagePart = parts?.find((p: any) => p.inlineData);

					if (imagePart?.inlineData) {
						const base64Data = imagePart.inlineData.data;
						const mimeType = imagePart.inlineData.mimeType || "image/png";

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
					const errBody = await geminiResponse.text().catch(() => "");
					console.warn("Gemini image generation failed, falling back to Flux:", geminiResponse.status, errBody);
				}
			} catch (geminiError) {
				console.error("Gemini generation error:", geminiError);
			}
		}

		// Fallback to Cloudflare Workers AI Flux-1-Schnell
		// Returns { image: "base64string" }
		console.log("Using Flux-1-Schnell for image generation");
		const result = (await env.AI.run(FALLBACK_IMAGE_MODEL, {
			prompt: prompt.trim(),
			num_steps: 4,
		})) as { image: string };

		if (!result?.image) {
			console.error("Flux returned unexpected format:", typeof result, JSON.stringify(result).substring(0, 200));
			throw new Error("Flux model returned no image data");
		}

		const binaryString = atob(result.image);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}

		return new Response(bytes.buffer, {
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

// ─── Vision Analysis ─────────────────────────────────────────────────────────

async function handleVisionAnalysis(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		if (!env.GEMINI_API_KEY) {
			return new Response(
				JSON.stringify({ error: "Vision analysis requires Gemini API key" }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}

		const { image, mimeType, question } = (await request.json()) as {
			image: string;
			mimeType: string;
			question?: string;
		};

		if (!image || !mimeType) {
			return new Response(
				JSON.stringify({ error: "Image data and mimeType are required" }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}

		const prompt = question || "Analyze this image in detail. Describe everything you see.";
		const geminiUrl = `${GEMINI_API_BASE}/models/gemini-2.0-flash-exp:generateContent?key=${env.GEMINI_API_KEY}`;

		const response = await fetch(geminiUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{
					parts: [
						{ text: prompt },
						{ inlineData: { mimeType, data: image } },
					],
				}],
				generationConfig: { maxOutputTokens: 1024 },
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Gemini vision API returned ${response.status}: ${errText}`);
		}

		const data = (await response.json()) as any;
		const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || "Could not analyze the image.";

		return new Response(
			JSON.stringify({ analysis }),
			{ headers: { "content-type": "application/json" } },
		);
	} catch (error) {
		console.error("Vision analysis error:", error);
		return new Response(
			JSON.stringify({ error: "Vision analysis failed" }),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}
}

// ─── Web Search Grounding ────────────────────────────────────────────────────

async function handleWebSearch(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		if (!env.GEMINI_API_KEY) {
			return new Response(
				JSON.stringify({ error: "Web search requires Gemini API key" }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}

		const { query } = (await request.json()) as { query: string };

		if (!query || query.trim().length === 0) {
			return new Response(
				JSON.stringify({ error: "Search query is required" }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}

		const geminiUrl = `${GEMINI_API_BASE}/models/gemini-2.0-flash-exp:generateContent?key=${env.GEMINI_API_KEY}`;

		const response = await fetch(geminiUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{
					parts: [{ text: query.trim() }],
				}],
				tools: [{ googleSearch: {} }],
				generationConfig: { maxOutputTokens: 1024 },
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Gemini search API returned ${response.status}: ${errText}`);
		}

		const data = (await response.json()) as any;
		const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || "No results found.";
		const groundingMetadata = data.candidates?.[0]?.groundingMetadata;

		// Extract source URLs if available
		const sources: { title: string; url: string }[] = [];
		if (groundingMetadata?.groundingChunks) {
			for (const chunk of groundingMetadata.groundingChunks) {
				if (chunk.web?.uri) {
					sources.push({
						title: chunk.web.title || chunk.web.uri,
						url: chunk.web.uri,
					});
				}
			}
		}

		return new Response(
			JSON.stringify({ answer, sources }),
			{ headers: { "content-type": "application/json" } },
		);
	} catch (error) {
		console.error("Web search error:", error);
		return new Response(
			JSON.stringify({ error: "Web search failed" }),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}
}
