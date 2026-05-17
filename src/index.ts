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

		if (url.pathname === "/api/memory" && request.method === "GET") {
			try {
				const memory = (await env.ELEEN_MEMORY.get(userId)) || "";
				return Response.json({ memory });
			} catch (e: any) {
				return Response.json({ error: e.message }, { status: 500 });
			}
		}

		if (url.pathname === "/api/memory" && request.method === "POST") {
			try {
				const { memory } = (await request.json()) as { memory: string };
				if (memory === undefined) return new Response("Bad Request", { status: 400 });

				if (memory.length > MAX_MEMORY_SIZE) {
					return Response.json(
						{ error: `Memory profile exceeds maximum limit of ${MAX_MEMORY_SIZE} bytes` },
						{ status: 400 },
					);
				}

				if (memory.trim()) {
					await env.ELEEN_MEMORY.put(userId, memory.trim());
				} else {
					await env.ELEEN_MEMORY.delete(userId);
				}
				return Response.json({ success: true });
			} catch (e: any) {
				return Response.json({ error: e.message }, { status: 500 });
			}
		}

		// ── D1 Conversations Endpoints ─────────────────────────────────────
		if (url.pathname === "/api/conversations" && request.method === "GET") {
			try {
				const { results } = await env.DB.prepare(
					"SELECT id, title, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC"
				).bind(userId).all();
				return Response.json({ conversations: results });
			} catch (e: any) {
				return Response.json({ error: e.message }, { status: 500 });
			}
		}

		if (url.pathname.startsWith("/api/conversations/") && request.method === "GET") {
			const id = url.pathname.split("/").pop();
			if (!id) return new Response("Bad Request", { status: 400 });
			const result = await env.DB.prepare(
				"SELECT * FROM conversations WHERE id = ? AND user_id = ?"
			).bind(id, userId).first();
			if (!result) return new Response("Not Found", { status: 404 });
			return Response.json(result);
		}

		if (url.pathname === "/api/conversations" && request.method === "POST") {
			const body = await request.json() as any;
			const { id, messages } = body;
			if (!id || !messages) return new Response("Bad Request", { status: 400 });

			// Check if conversation exists
			const existing = await env.DB.prepare("SELECT title FROM conversations WHERE id = ? AND user_id = ?").bind(id, userId).first();
			
			let title = (existing?.title as string) || "New Chat";
			
			// Auto-generate title if it's a "New Chat" and we have at least one user + assistant message
			if (title === "New Chat" && messages.length >= 2) {
				const userMsg = messages.find((m: any) => m.role === "user");
				const asstMsg = messages.find((m: any) => m.role === "assistant");
				if (userMsg && asstMsg) {
					const prompt = `Based on the following short exchange, generate a concise 3-4 word title for this conversation. Return ONLY the title, no quotes or prefix.\n\nUser: ${userMsg.content}\nAssistant: ${asstMsg.content}`;
					try {
						const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
							messages: [{ role: "user", content: prompt }],
							max_tokens: 15
						}) as any;
						if (aiResponse.response) {
							title = aiResponse.response.replace(/["']/g, "").trim();
						}
					} catch (e) {
						console.error("Title generation failed", e);
					}
				}
			}

			await env.DB.prepare(
				"INSERT INTO conversations (id, user_id, title, messages) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, title = excluded.title"
			).bind(id, userId, title, JSON.stringify(messages)).run();

			return Response.json({ success: true, title });
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

		// ─── Hierarchical Summarization check ───
		const conversationalMsgs = messages.filter(m => m.role !== "system");
		let summarizedMessages = [...messages];

		if (userId !== "guest" && conversationalMsgs.length >= 15) {
			// Find indices of conversational messages in the original array
			const conversationalIndices: number[] = [];
			for (let i = 0; i < messages.length; i++) {
				if (messages[i].role !== "system") {
					conversationalIndices.push(i);
				}
			}

			if (conversationalIndices.length >= 15) {
				const oldestIndices = conversationalIndices.slice(0, 10);
				const oldestMsgs = oldestIndices.map(idx => messages[idx]);

				const conversationText = oldestMsgs
					.map(m => `${m.role.toUpperCase()}: ${m.content}`)
					.join("\n");

				const summaryPrompt = `Summarize the following past exchange between the user and assistant in 2-3 concise sentences. Focus ONLY on crucial facts, user preferences, and key technical details established. Do not include any meta-commentary, greetings, or introductory phrases.`;

				try {
					const summaryResponse = await env.AI.run(MODEL_ID, {
						messages: [
							{ role: "system", content: summaryPrompt },
							{ role: "user", content: conversationText }
						],
						max_tokens: 150
					}) as any;

					const summaryText = summaryResponse.response?.trim();
					if (summaryText) {
						const systemSummaryMsg: ChatMessage = {
							role: "system",
							content: `Earlier in this conversation: ${summaryText}`
						};

						// Build new messages array
						const firstIndexToReplace = oldestIndices[0];
						const lastIndexToReplace = oldestIndices[oldestIndices.length - 1];

						const before = messages.slice(0, firstIndexToReplace);
						const after = messages.slice(lastIndexToReplace + 1);

						summarizedMessages = [...before, systemSummaryMsg, ...after];
						console.log("Hierarchical summarization completed successfully!");
					}
				} catch (e) {
					console.error("Hierarchical summarization failed:", e);
				}
			}
		}

		// 4. Run the AI Model
		const stream = await env.AI.run(MODEL_ID, {
			messages: summarizedMessages,
			max_tokens: maxTokens,
			stream: true,
		}) as any;

		// 5. Dynamic Background Persistence (Non-blocking)
		if (userId !== "guest" && body.id && env.DB) {
			const [clientStream, bgStream] = stream.tee();
			
			ctx.waitUntil(consumeStreamAndSave(env, userId, body.id, summarizedMessages, bgStream));
			
			if (env.ELEEN_MEMORY) {
				ctx.waitUntil(updateMemory(env, userId, summarizedMessages, rawMemory));
			}

			return new Response(clientStream, {
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					connection: "keep-alive",
				},
			});
		} else {
			if (userId !== "guest" && env.ELEEN_MEMORY) {
				ctx.waitUntil(updateMemory(env, userId, summarizedMessages, rawMemory));
			}

			return new Response(stream, {
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache",
					connection: "keep-alive",
				},
			});
		}
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}
}

// ─── Stream Accumulator & D1 Database Saver ──────────────────────────────────

async function consumeStreamAndSave(
	env: Env,
	userId: string,
	conversationId: string,
	messages: ChatMessage[],
	stream: ReadableStream,
) {
	try {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let assistantResponse = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const chunk = decoder.decode(value, { stream: true });
			const lines = chunk.split("\n");
			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const dataStr = line.slice(6).trim();
					if (dataStr === "[DONE]") break;
					try {
						const parsed = JSON.parse(dataStr);
						if (parsed.response) {
							assistantResponse += parsed.response;
						}
					} catch {}
				}
			}
		}

		if (assistantResponse.trim()) {
			const updatedMessages = [
				...messages,
				{ role: "assistant" as const, content: assistantResponse }
			];

			const existing = await env.DB.prepare(
				"SELECT title FROM conversations WHERE id = ? AND user_id = ?"
			).bind(conversationId, userId).first();

			let title = (existing?.title as string) || "New Chat";

			if (title === "New Chat" && updatedMessages.length >= 2) {
				const userMsg = updatedMessages.find(m => m.role === "user");
				const asstMsg = updatedMessages.find(m => m.role === "assistant");
				if (userMsg && asstMsg) {
					const prompt = `Based on the following short exchange, generate a concise 3-4 word title for this conversation. Return ONLY the title, no quotes or prefix.\n\nUser: ${userMsg.content}\nAssistant: ${asstMsg.content}`;
					try {
						const aiResponse = await env.AI.run(MODEL_ID, {
							messages: [{ role: "user", content: prompt }],
							max_tokens: 15
						}) as any;
						if (aiResponse.response) {
							title = aiResponse.response.replace(/["']/g, "").trim();
						}
					} catch (e) {
						console.error("D1 background title generation failed", e);
					}
				}
			}

			await env.DB.prepare(
				"INSERT INTO conversations (id, user_id, title, messages) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, title = excluded.title"
			).bind(conversationId, userId, title, JSON.stringify(updatedMessages)).run();
		}
	} catch (e) {
		console.error("D1 background save failed:", e);
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
