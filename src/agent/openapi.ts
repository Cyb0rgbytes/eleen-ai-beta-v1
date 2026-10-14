/**
 * OpenAPI 3.1 description, health endpoint and human-readable docs page.
 *
 * These are prerequisites for the API catalog (item 5) — every `href` in the
 * linkset has to resolve — and they are the `service-desc` / `service-doc` /
 * `status` targets of the Link headers (item 2).
 *
 * The document is authored as a typed object rather than a JSON blob so the
 * compiler catches structural mistakes. Every status code, media type and
 * limit below is traced from the actual handlers in src/index.ts; a
 * description that lies about the API is worse than none at all.
 */
import { API_VERSION, ORIGIN } from "./config";

const ERROR_SCHEMA = {
	type: "object",
	properties: { error: { type: "string" } },
	required: ["error"],
} as const;

/** Reused by every endpoint that decodes a JSON body. */
const JSON_ERRORS = {
	"400": {
		description: "Required field missing or empty.",
		content: { "application/json": { schema: ERROR_SCHEMA } },
	},
	"413": {
		description: "Request body exceeds the size limit.",
		content: { "application/json": { schema: ERROR_SCHEMA } },
	},
	"500": {
		description: "Upstream model or provider failure.",
		content: { "application/json": { schema: ERROR_SCHEMA } },
	},
};

/** Returned by the two endpoints that hard-depend on the Gemini provider. */
const GEMINI_UNAVAILABLE = {
	"503": {
		description: "The Gemini provider is not configured on this deployment.",
		content: { "application/json": { schema: ERROR_SCHEMA } },
	},
};

const UNAUTHORIZED = {
	"401": {
		description:
			"No or invalid bearer token. Carries a WWW-Authenticate challenge naming " +
			"the protected resource metadata document.",
		content: { "application/json": { schema: ERROR_SCHEMA } },
	},
};

const CHAT_RESPONSE = {
	"200": {
		description:
			"Server-sent event stream. Each `data:` line carries a JSON object with a " +
			"`response` string holding the next token delta; the stream terminates with " +
			"`data: [DONE]`.",
		content: {
			"text/event-stream": {
				schema: { type: "string" },
			},
		},
	},
};

const IMAGE_RESPONSE = {
	"200": {
		description:
			"Raw image bytes — not JSON. `image/jpeg` when served by the primary " +
			"provider, `image/png` from the fallback model.",
		content: {
			"image/jpeg": { schema: { type: "string", format: "binary" } },
			"image/png": { schema: { type: "string", format: "binary" } },
		},
	},
};

function chatBody(guest: boolean) {
	return {
		required: true,
		content: {
			"application/json": {
				schema: { $ref: "#/components/schemas/ChatRequest" },
			},
		},
		description: guest
			? "Guest requests are capped at 512 output tokens."
			: "Authenticated requests receive 1024 output tokens.",
	};
}

export const OPENAPI_DOCUMENT = {
	openapi: "3.1.0",
	info: {
		title: "EleenAI API",
		version: API_VERSION,
		summary: "Multimodal AI assistant: chat, image generation, vision and grounded search.",
		description:
			"EleenAI exposes streaming chat, text-to-image generation, image and document " +
			"understanding, and web-search-grounded answers.\n\n" +
			"Most capabilities are available in two tiers. The `/guest` paths need no " +
			"credentials and run at reduced limits. The unsuffixed paths require a bearer " +
			"token issued by the authorization server named in " +
			"`/.well-known/oauth-protected-resource`. See /auth.md for the full flow.",
		license: { name: "MIT", identifier: "MIT" },
		contact: { name: "EleenAI", url: `${ORIGIN}/docs` },
	},
	servers: [{ url: ORIGIN, description: "Production" }],
	externalDocs: { description: "Authentication guide", url: `${ORIGIN}/auth.md` },
	tags: [
		{ name: "chat", description: "Conversational completions" },
		{ name: "image", description: "Image generation" },
		{ name: "vision", description: "Image and document understanding" },
		{ name: "search", description: "Web-search-grounded answers" },
		{ name: "meta", description: "Service metadata" },
	],
	components: {
		securitySchemes: {
			clerkBearer: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT",
				description:
					"Bearer token in the Authorization header. Tokens in a query parameter " +
					"or request body are rejected.",
			},
		},
		schemas: {
			ChatMessage: {
				type: "object",
				properties: {
					role: {
						type: "string",
						enum: ["user", "assistant"],
						description:
							"Client-supplied `system` messages are discarded server-side.",
					},
					content: { type: "string" },
				},
				required: ["role", "content"],
			},
			Attachment: {
				type: "object",
				properties: {
					data: { type: "string", description: "Base64-encoded file contents." },
					mimeType: { type: "string" },
					name: { type: "string" },
				},
				required: ["data", "mimeType"],
			},
			ChatRequest: {
				type: "object",
				properties: {
					messages: {
						type: "array",
						items: { $ref: "#/components/schemas/ChatMessage" },
					},
					attachments: {
						type: "array",
						maxItems: 5,
						items: { $ref: "#/components/schemas/Attachment" },
					},
					mode: {
						type: "string",
						enum: ["balanced", "creative", "logical"],
						default: "balanced",
					},
				},
				required: ["messages"],
			},
			ImageRequest: {
				type: "object",
				properties: { prompt: { type: "string", minLength: 1 } },
				required: ["prompt"],
			},
			VisionRequest: {
				type: "object",
				properties: {
					image: { type: "string", description: "Base64-encoded image data." },
					mimeType: { type: "string", examples: ["image/png", "image/jpeg"] },
					question: {
						type: "string",
						description: "Optional. Defaults to a general description request.",
					},
				},
				required: ["image", "mimeType"],
			},
			VisionResponse: {
				type: "object",
				properties: { analysis: { type: "string" } },
				required: ["analysis"],
			},
			SearchRequest: {
				type: "object",
				properties: { query: { type: "string", minLength: 1 } },
				required: ["query"],
			},
			SearchResponse: {
				type: "object",
				properties: {
					answer: { type: "string" },
					sources: {
						type: "array",
						items: {
							type: "object",
							properties: {
								title: { type: "string" },
								url: { type: "string", format: "uri" },
							},
							required: ["title", "url"],
						},
					},
				},
				required: ["answer", "sources"],
			},
			EnhanceRequest: {
				type: "object",
				properties: {
					prompt: {
						type: "string",
						minLength: 1,
						description: "Truncated to 2000 characters.",
					},
				},
				required: ["prompt"],
			},
			EnhanceResponse: {
				type: "object",
				properties: { enhanced: { type: "string" } },
				required: ["enhanced"],
			},
			HealthResponse: {
				type: "object",
				properties: {
					status: { type: "string", enum: ["ok"] },
					version: { type: "string" },
					service: { type: "string" },
					capabilities: { type: "array", items: { type: "string" } },
				},
				required: ["status", "version", "service"],
			},
			Error: ERROR_SCHEMA,
		},
	},
	paths: {
		"/api/chat": {
			post: {
				tags: ["chat"],
				operationId: "chat",
				summary: "Streaming chat completion (authenticated)",
				description:
					"Conversation history is persisted to a per-user memory profile in the " +
					"background. Request bodies are limited to 6 MiB.",
				security: [{ clerkBearer: [] }],
				requestBody: chatBody(false),
				responses: { ...CHAT_RESPONSE, ...UNAUTHORIZED, ...JSON_ERRORS },
			},
		},
		"/api/chat/guest": {
			post: {
				tags: ["chat"],
				operationId: "chatGuest",
				summary: "Streaming chat completion (guest)",
				security: [],
				requestBody: chatBody(true),
				responses: { ...CHAT_RESPONSE, ...JSON_ERRORS },
			},
		},
		"/api/image/generate": {
			post: {
				tags: ["image"],
				operationId: "generateImage",
				summary: "Generate an image from a text prompt (authenticated)",
				description: "Request bodies are limited to 64 KiB.",
				security: [{ clerkBearer: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/ImageRequest" } },
					},
				},
				responses: { ...IMAGE_RESPONSE, ...UNAUTHORIZED, ...JSON_ERRORS },
			},
		},
		"/api/image/generate/guest": {
			post: {
				tags: ["image"],
				operationId: "generateImageGuest",
				summary: "Generate an image from a text prompt (guest)",
				security: [],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/ImageRequest" } },
					},
				},
				responses: { ...IMAGE_RESPONSE, ...JSON_ERRORS },
			},
		},
		"/api/vision/analyze": {
			post: {
				tags: ["vision"],
				operationId: "analyzeImage",
				summary: "Analyze an image or document (authenticated)",
				security: [{ clerkBearer: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/VisionRequest" } },
					},
				},
				responses: {
					"200": {
						description: "Analysis text.",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/VisionResponse" },
							},
						},
					},
					...UNAUTHORIZED,
					...JSON_ERRORS,
					...GEMINI_UNAVAILABLE,
				},
			},
		},
		"/api/vision/analyze/guest": {
			post: {
				tags: ["vision"],
				operationId: "analyzeImageGuest",
				summary: "Analyze an image or document (guest)",
				security: [],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/VisionRequest" } },
					},
				},
				responses: {
					"200": {
						description: "Analysis text.",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/VisionResponse" },
							},
						},
					},
					...JSON_ERRORS,
					...GEMINI_UNAVAILABLE,
				},
			},
		},
		"/api/search/ground": {
			post: {
				tags: ["search"],
				operationId: "search",
				summary: "Web-search-grounded answer with citations (authenticated)",
				security: [{ clerkBearer: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } },
					},
				},
				responses: {
					"200": {
						description: "Answer plus the sources it was grounded on.",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/SearchResponse" },
							},
						},
					},
					...UNAUTHORIZED,
					...JSON_ERRORS,
					...GEMINI_UNAVAILABLE,
				},
			},
		},
		"/api/search/ground/guest": {
			post: {
				tags: ["search"],
				operationId: "searchGuest",
				summary: "Web-search-grounded answer with citations (guest)",
				security: [],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } },
					},
				},
				responses: {
					"200": {
						description: "Answer plus the sources it was grounded on.",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/SearchResponse" },
							},
						},
					},
					...JSON_ERRORS,
					...GEMINI_UNAVAILABLE,
				},
			},
		},
		"/api/enhance-prompt": {
			post: {
				tags: ["chat"],
				operationId: "enhancePrompt",
				summary: "Rewrite a rough prompt into a more effective one",
				security: [],
				requestBody: {
					required: true,
					content: {
						"application/json": { schema: { $ref: "#/components/schemas/EnhanceRequest" } },
					},
				},
				responses: {
					"200": {
						description: "The rewritten prompt.",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/EnhanceResponse" },
							},
						},
					},
					...JSON_ERRORS,
				},
			},
		},
		"/api/v1/health": {
			get: {
				tags: ["meta"],
				operationId: "health",
				summary: "Service liveness and advertised capabilities",
				description:
					"Static. Deliberately touches no model provider, so polling it costs " +
					"nothing and cannot be used to drain inference quota.",
				security: [],
				responses: {
					"200": {
						description: "Service is up.",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/HealthResponse" },
							},
						},
					},
				},
			},
		},
	},
} as const;

export const OPENAPI_JSON = JSON.stringify(OPENAPI_DOCUMENT, null, 2) + "\n";

export const HEALTH_DOCUMENT = {
	status: "ok",
	version: API_VERSION,
	service: "eleenai",
	capabilities: ["chat", "image-generation", "vision", "web-search", "mcp"],
} as const;
