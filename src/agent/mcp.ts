/**
 * Item 9 — Model Context Protocol over Streamable HTTP.
 *
 * A real JSON-RPC endpoint, not a card pointing at nothing. Stateless: no
 * Mcp-Session-Id is issued and no server-initiated SSE channel is offered,
 * both of which the spec permits.
 *
 * Spec note: the server card was originally SEP-1649 at
 * /.well-known/mcp/server-card.json and was superseded by SEP-2127 at
 * /.well-known/mcp.json with a registry-derived shape. Both paths are served
 * with the same body so either generation of client can discover us.
 */
import { createClerkClient } from "@clerk/backend";
import { Env } from "../types";
import { API_VERSION, ORIGIN, absolute } from "./config";
import { AgentHandlers, GUEST_TIER, Tier } from "./deps";
import { bearerChallenge } from "./wellknown";
import { collectSseText } from "./sse";

/** Newest first. We echo the client's version when we know it. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

const SERVER_NAME = "eleenai";

export const MCP_SERVER_CARD = {
	$schema: "https://static.modelcontextprotocol.io/schemas/2025-10-17/server.schema.json",
	name: "xyz.eleenai/eleenai",
	description:
		"Multimodal AI assistant: streaming chat, image generation, and web-search-grounded " +
		"answers with citations.",
	version: API_VERSION,
	websiteUrl: ORIGIN,
	remotes: [{ type: "streamable-http", url: `${ORIGIN}/mcp` }],
} as const;

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
	{
		name: "eleenai_chat",
		title: "Chat with EleenAI",
		description:
			"Ask EleenAI a question and receive a complete text answer. Handles general " +
			"knowledge, reasoning, analysis and code.",
		inputSchema: {
			type: "object",
			properties: {
				message: { type: "string", description: "The question or instruction." },
				mode: {
					type: "string",
					enum: ["balanced", "creative", "logical"],
					description:
						"balanced (default), creative for open-ended generation, logical for " +
						"step-by-step rigor.",
				},
			},
			required: ["message"],
			additionalProperties: false,
		},
	},
	{
		name: "eleenai_generate_image",
		title: "Generate an image",
		description:
			"Generate an image from a text prompt. Returns the image itself. Detailed " +
			"prompts with style hints produce better results.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "Description of the image to generate." },
			},
			required: ["prompt"],
			additionalProperties: false,
		},
	},
	{
		name: "eleenai_search",
		title: "Search the web",
		description:
			"Answer a question using live web search, returning the answer together with " +
			"the sources it was grounded on. Use for current events or anything needing " +
			"up-to-date information.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "The search question." },
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
] as const;

// ─── JSON-RPC plumbing ───────────────────────────────────────────────────────

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

const enum RpcError {
	ParseError = -32700,
	InvalidRequest = -32600,
	MethodNotFound = -32601,
	InvalidParams = -32602,
	InternalError = -32603,
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers":
		"content-type, authorization, mcp-protocol-version, mcp-session-id",
	"Access-Control-Expose-Headers": "mcp-session-id, www-authenticate",
	"Access-Control-Max-Age": "86400",
};

function rpcResponse(id: string | number | null | undefined, result: unknown): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
		headers: { "content-type": "application/json", ...CORS_HEADERS },
	});
}

function rpcError(
	id: string | number | null | undefined,
	code: RpcError,
	message: string,
	status = 200,
): Response {
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
		{ status, headers: { "content-type": "application/json", ...CORS_HEADERS } },
	);
}

/** A failed tool is reported in-band, so the model can see and react to it. */
function toolError(id: string | number | null | undefined, message: string): Response {
	return rpcResponse(id, { content: [{ type: "text", text: message }], isError: true });
}

// ─── Tier resolution ─────────────────────────────────────────────────────────

/**
 * MCP is public and runs the guest tier by default. A bearer token, if
 * supplied, must be valid — silently degrading a rejected token to guest would
 * hide auth failures from the caller.
 */
async function resolveTier(request: Request, env: Env): Promise<Tier | Response> {
	const authorization = request.headers.get("authorization");
	if (!/^Bearer\s+\S/i.test(authorization || "")) return GUEST_TIER;

	try {
		const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
		const authState = await clerk.authenticateRequest(request, {
			secretKey: env.CLERK_SECRET_KEY,
			publishableKey: env.CLERK_PUBLISHABLE_KEY,
		});

		if (authState.isSignedIn) {
			const { userId } = authState.toAuth();
			return { userId, maxTokens: 1024, authenticated: true };
		}
	} catch (error) {
		console.error("MCP auth error:", error);
	}

	return new Response(JSON.stringify({ error: "Invalid or expired access token." }), {
		status: 401,
		headers: {
			"content-type": "application/json",
			"WWW-Authenticate": bearerChallenge(request, "mcp"),
			...CORS_HEADERS,
		},
	});
}

// ─── Tool implementations ────────────────────────────────────────────────────

/**
 * Tools invoke the application handlers directly with a synthetic Request.
 * There is no network hop, so global_fetch_strictly_public is irrelevant here
 * and the call cannot be intercepted.
 */
function syntheticRequest(path: string, payload: unknown): Request {
	return new Request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	// Chunked to stay clear of the argument-count limit on large images.
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

async function errorTextFrom(response: Response, fallback: string): Promise<string> {
	try {
		const data = (await response.json()) as { error?: string };
		return data.error || fallback;
	} catch {
		return fallback;
	}
}

async function callChat(
	handlers: AgentHandlers,
	env: Env,
	ctx: ExecutionContext,
	args: Record<string, unknown>,
	tier: Tier,
): Promise<{ content: unknown[]; isError?: boolean }> {
	const message = typeof args.message === "string" ? args.message : "";
	if (!message.trim()) return { content: [{ type: "text", text: "message is required." }], isError: true };

	const mode = typeof args.mode === "string" ? args.mode : "balanced";
	const request = syntheticRequest("/api/chat", {
		messages: [{ role: "user", content: message }],
		mode,
	});

	const response = await handlers.chat(request, env, ctx, tier.userId, tier.maxTokens);
	if (!response.ok) {
		return {
			content: [{ type: "text", text: await errorTextFrom(response, "Chat request failed.") }],
			isError: true,
		};
	}

	const text = await collectSseText(response);
	return { content: [{ type: "text", text: text || "(empty response)" }] };
}

async function callImage(
	handlers: AgentHandlers,
	env: Env,
	args: Record<string, unknown>,
): Promise<{ content: unknown[]; isError?: boolean }> {
	const prompt = typeof args.prompt === "string" ? args.prompt : "";
	if (!prompt.trim()) return { content: [{ type: "text", text: "prompt is required." }], isError: true };

	const response = await handlers.image(syntheticRequest("/api/image/generate", { prompt }), env);
	if (!response.ok) {
		return {
			content: [{ type: "text", text: await errorTextFrom(response, "Image generation failed.") }],
			isError: true,
		};
	}

	// This handler returns raw image bytes, not JSON.
	const buffer = await response.arrayBuffer();
	return {
		content: [
			{
				type: "image",
				data: toBase64(buffer),
				mimeType: response.headers.get("content-type") || "image/png",
			},
		],
	};
}

async function callSearch(
	handlers: AgentHandlers,
	env: Env,
	args: Record<string, unknown>,
): Promise<{ content: unknown[]; isError?: boolean }> {
	const query = typeof args.query === "string" ? args.query : "";
	if (!query.trim()) return { content: [{ type: "text", text: "query is required." }], isError: true };

	const response = await handlers.search(syntheticRequest("/api/search/ground", { query }), env);
	if (!response.ok) {
		return {
			content: [{ type: "text", text: await errorTextFrom(response, "Search failed.") }],
			isError: true,
		};
	}

	const data = (await response.json()) as {
		answer?: string;
		sources?: { title: string; url: string }[];
	};

	let text = data.answer || "No results found.";
	if (data.sources?.length) {
		text += "\n\nSources:\n" + data.sources.map((s) => `- [${s.title}](${s.url})`).join("\n");
	}

	return { content: [{ type: "text", text }] };
}

// ─── Endpoint ────────────────────────────────────────────────────────────────

export async function handleMcp(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	handlers: AgentHandlers,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	// No server-initiated stream is offered, so there is nothing to GET.
	if (request.method === "GET") {
		return new Response(null, {
			status: 405,
			headers: { allow: "POST, OPTIONS", ...CORS_HEADERS },
		});
	}

	// Session teardown. Stateless, so this is a no-op that must still succeed.
	if (request.method === "DELETE") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	if (request.method !== "POST") {
		return new Response(null, {
			status: 405,
			headers: { allow: "POST, GET, DELETE, OPTIONS", ...CORS_HEADERS },
		});
	}

	let message: JsonRpcRequest;
	try {
		message = (await request.json()) as JsonRpcRequest;
	} catch {
		return rpcError(null, RpcError.ParseError, "Invalid JSON.", 400);
	}

	if (!message || typeof message !== "object" || Array.isArray(message)) {
		return rpcError(null, RpcError.InvalidRequest, "Batch requests are not supported.", 400);
	}

	const { id, method, params } = message;

	// A message without an id is a notification: acknowledge, return nothing.
	if (id === undefined || id === null) {
		return new Response(null, { status: 202, headers: CORS_HEADERS });
	}

	if (typeof method !== "string") {
		return rpcError(id, RpcError.InvalidRequest, "Missing method.");
	}

	switch (method) {
		case "initialize": {
			const requested = params?.protocolVersion;
			const protocolVersion =
				typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
					? requested
					: SUPPORTED_PROTOCOL_VERSIONS[0];

			return rpcResponse(id, {
				protocolVersion,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: SERVER_NAME, version: API_VERSION },
				instructions:
					"EleenAI exposes chat, image generation and web-search-grounded answers. " +
					"Unauthenticated callers use the guest tier (512 output tokens). Send an " +
					"Authorization: Bearer token for the full tier. See " +
					`${absolute("/auth.md")} for the authentication flow.`,
			});
		}

		case "ping":
			return rpcResponse(id, {});

		case "tools/list":
			return rpcResponse(id, { tools: TOOLS });

		case "tools/call": {
			const name = params?.name;
			const args = (params?.arguments ?? {}) as Record<string, unknown>;

			if (typeof name !== "string") {
				return rpcError(id, RpcError.InvalidParams, "Missing tool name.");
			}

			const tier = await resolveTier(request, env);
			if (tier instanceof Response) return tier;

			try {
				switch (name) {
					case "eleenai_chat":
						return rpcResponse(id, await callChat(handlers, env, ctx, args, tier));
					case "eleenai_generate_image":
						return rpcResponse(id, await callImage(handlers, env, args));
					case "eleenai_search":
						return rpcResponse(id, await callSearch(handlers, env, args));
					default:
						return rpcError(id, RpcError.InvalidParams, `Unknown tool: ${name}`);
				}
			} catch (error) {
				console.error(`MCP tool ${name} failed:`, error);
				return toolError(id, `Tool ${name} failed unexpectedly.`);
			}
		}

		// Declared unsupported in `capabilities`, but answer politely rather
		// than erroring — some clients probe these regardless.
		case "resources/list":
			return rpcResponse(id, { resources: [] });
		case "prompts/list":
			return rpcResponse(id, { prompts: [] });

		default:
			return rpcError(id, RpcError.MethodNotFound, `Unknown method: ${method}`);
	}
}
