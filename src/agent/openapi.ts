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

const MODEL_FORBIDDEN = {
	"403": {
		description:
			"The requested model is not available to this caller: `reason` is " +
			"`sign-in` for a model reserved for authenticated users, or `key-required` " +
			"for a third-party model that runs only with the caller's own provider key.",
		content: {
			"application/json": {
				schema: {
					type: "object",
					properties: {
						error: { type: "string" },
						model: { type: "string" },
						reason: { type: "string", enum: ["sign-in", "key-required"] },
					},
					required: ["error", "model", "reason"],
				},
			},
		},
	},
};

const CHAT_RESPONSE = {
	"200": {
		description:
			"Server-sent event stream. With the default `protocol` 1, each `data:` line " +
			"carries a JSON object with a `response` string holding the next token " +
			"delta and the stream terminates with `data: [DONE]`. With `protocol` 2 the " +
			"stream uses named events: `meta`, `reasoning`, `token`, `usage`, `error`, " +
			"`done`, each with a JSON `data:` payload.",
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

const RATE_LIMITED = {
	"429": {
		description: "Hourly allowance spent. `Retry-After` says when to try again.",
		content: { "application/json": { schema: ERROR_SCHEMA } },
	},
};

// ─── History (src/api/history.ts, contract in src/shared/history.ts) ────────

const HISTORY_ERRORS = {
	...UNAUTHORIZED,
	"422": {
		description: "Invalid body or query, with `details` naming each field.",
		content: { "application/json": { schema: ERROR_SCHEMA } },
	},
	...RATE_LIMITED,
};

const NOT_FOUND = {
	"404": {
		description:
			"No such id among the caller's own rows. Another user's id is a 404 too, never a 403, " +
			"so the answer does not reveal that it exists.",
		content: { "application/json": { schema: ERROR_SCHEMA } },
	},
};

const ID_PARAM = {
	name: "id",
	in: "path",
	required: true,
	schema: { type: "string", format: "uuid" },
} as const;

function jsonOk(description: string, schema: string, status = "200") {
	return {
		[status]: {
			description,
			content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
		},
	};
}

function jsonBody(schema: Record<string, unknown>) {
	return { required: true, content: { "application/json": { schema } } };
}

function wrapped(key: string, schema: string) {
	return {
		type: "object",
		properties: { [key]: { $ref: `#/components/schemas/${schema}` } },
		required: [key],
	};
}

const HISTORY_SECURITY = [{ clerkBearer: [] }];

function transcribePath(signedIn: boolean) {
	return {
		post: {
			tags: ["voice"],
			operationId: signedIn ? "transcribe" : "transcribeGuest",
			summary: `Transcribe a short recording to text${signedIn ? "" : " (guest)"}`,
			security: signedIn ? [{ clerkBearer: [] }] : [],
			parameters: [
				{
					name: "lang",
					in: "query",
					required: false,
					description: "Language hint. Anything else is auto-detected.",
					schema: { type: "string", enum: ["en", "ar"] },
				},
			],
			requestBody: {
				required: true,
				description: "Raw audio bytes, at most 1.5 MB: WebM, Ogg, MP4, WAV or MP3.",
				content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
			},
			responses: {
				"200": {
					description: "The transcript.",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { text: { type: "string" }, language: { type: ["string", "null"] } },
								required: ["text"],
							},
						},
					},
				},
				...(signedIn ? UNAUTHORIZED : {}),
				"413": { description: "Recording too long.", content: { "application/json": { schema: ERROR_SCHEMA } } },
				"415": { description: "Not a supported audio format.", content: { "application/json": { schema: ERROR_SCHEMA } } },
				"422": { description: "Empty body.", content: { "application/json": { schema: ERROR_SCHEMA } } },
				...RATE_LIMITED,
			},
		},
	};
}

function speakPath(signedIn: boolean) {
	return {
		post: {
			tags: ["voice"],
			operationId: signedIn ? "speak" : "speakGuest",
			summary: `Read English text aloud${signedIn ? "" : " (guest)"}`,
			security: signedIn ? [{ clerkBearer: [] }] : [],
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: { text: { type: "string", minLength: 1, maxLength: 1500 } },
							required: ["text"],
						},
					},
				},
			},
			responses: {
				"200": {
					description: "MP3 audio of the text, spoken in English.",
					content: { "audio/mpeg": { schema: { type: "string", format: "binary" } } },
				},
				...(signedIn ? UNAUTHORIZED : {}),
				"415": { description: "Body is not JSON.", content: { "application/json": { schema: ERROR_SCHEMA } } },
				"422": { description: "Text missing or too long.", content: { "application/json": { schema: ERROR_SCHEMA } } },
				...RATE_LIMITED,
			},
		},
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
		{ name: "voice", description: "Speech to text and text to speech" },
		{ name: "history", description: "The caller's saved conversations, folders and search" },
		{ name: "privacy", description: "Consent and long-term memory" },
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
					model: {
						type: "string",
						description:
							"A model id or tier name (`fast`, `smart`, `reasoning`) from " +
							"/api/v1/models. Omitted means the default model. An unknown value " +
							"is a 422.",
					},
					protocol: {
						type: "integer",
						enum: [1, 2],
						default: 1,
						description:
							"Stream encoding. 1 is the `response`/`[DONE]` framing; 2 uses named " +
							"events and carries reasoning and usage.",
					},
					voice: {
						type: "boolean",
						description:
							"The user asked by voice and will hear the reply: it is kept to a few " +
							"short spoken sentences.",
					},
					conversationId: {
						type: "string",
						format: "uuid",
						description:
							"Saved chat (protocol 2, signed in, history consent on): the conversation " +
							"to add the turn to. Omitted starts a new one. The server rebuilds the " +
							"context from the stored thread and ignores the history in `messages`; " +
							"only the last message, the new user turn, is used. Ignored otherwise.",
					},
					parentId: {
						type: ["string", "null"],
						format: "uuid",
						description:
							"Saved chat: the message the new turn follows. null starts a new first " +
							"turn (an edit of the first message); omitted continues from the " +
							"conversation's active leaf.",
					},
					replyTo: {
						type: "string",
						format: "uuid",
						description:
							"Saved chat: regenerate the answer to this user message as a new " +
							"sibling. Requires `conversationId`; `messages` may then be empty.",
					},
				},
				required: ["messages"],
			},
			Consent: {
				type: "object",
				properties: {
					history: { type: "boolean", description: "Conversations are saved. Default on." },
					memory: { type: "boolean", description: "Facts about the user are remembered. Default off." },
					policyVersion: { type: "integer" },
					updatedAt: { type: "integer", description: "Unix milliseconds." },
				},
				required: ["history", "memory", "policyVersion", "updatedAt"],
			},
			ConsentResponse: {
				type: "object",
				properties: {
					consent: {
						oneOf: [{ $ref: "#/components/schemas/Consent" }, { type: "null" }],
						description: "null until the user has answered; history is then on and memory off.",
					},
					policyVersion: { type: "integer", description: "Ask again when consent.policyVersion is lower." },
				},
				required: ["consent", "policyVersion"],
			},
			MemoryEntry: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					fact: { type: "string", maxLength: 500 },
					createdAt: { type: "integer" },
				},
				required: ["id", "fact", "createdAt"],
			},
			MemoryList: {
				type: "object",
				properties: { entries: { type: "array", items: { $ref: "#/components/schemas/MemoryEntry" } } },
				required: ["entries"],
			},
			ConversationSummary: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					title: { type: "string", maxLength: 200 },
					pinned: { type: "boolean" },
					folderId: { type: ["string", "null"], format: "uuid" },
					createdAt: { type: "integer" },
					updatedAt: { type: "integer" },
				},
				required: ["id", "title", "pinned", "folderId", "createdAt", "updatedAt"],
			},
			ConversationList: {
				type: "object",
				properties: {
					conversations: {
						type: "array",
						maxItems: 50,
						items: { $ref: "#/components/schemas/ConversationSummary" },
						description: "Pinned first, then most recently updated.",
					},
					nextCursor: { type: ["string", "null"], description: "Pass as `cursor` for the next page." },
				},
				required: ["conversations", "nextCursor"],
			},
			StoredMessage: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					parentId: { type: ["string", "null"], format: "uuid" },
					seq: { type: "integer", description: "Creation order; siblings sort by it." },
					role: { type: "string", enum: ["user", "assistant"] },
					content: { type: "string" },
					reasoning: { type: ["string", "null"] },
					model: { type: ["string", "null"] },
					status: { type: "string", enum: ["streaming", "complete", "stopped", "error"] },
					compareGroup: { type: ["string", "null"] },
					completionTokens: { type: ["integer", "null"] },
					createdAt: { type: "integer" },
				},
				required: ["id", "parentId", "seq", "role", "content", "status", "createdAt"],
			},
			ConversationDetail: {
				type: "object",
				properties: {
					conversation: {
						allOf: [
							{ $ref: "#/components/schemas/ConversationSummary" },
							{
								type: "object",
								properties: { activeLeafId: { type: ["string", "null"], format: "uuid" } },
								required: ["activeLeafId"],
							},
						],
					},
					messages: {
						type: "array",
						items: { $ref: "#/components/schemas/StoredMessage" },
						description: "The whole tree, ordered by seq.",
					},
				},
				required: ["conversation", "messages"],
			},
			Folder: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					name: { type: "string", minLength: 1, maxLength: 80 },
					position: { type: "integer" },
				},
				required: ["id", "name", "position"],
			},
			HistorySearchResponse: {
				type: "object",
				properties: {
					results: {
						type: "array",
						maxItems: 20,
						items: {
							type: "object",
							properties: {
								conversationId: { type: "string", format: "uuid" },
								messageId: { type: "string", format: "uuid" },
								title: { type: "string" },
								snippet: { type: "string", description: "Plain text around the match. Never HTML." },
								createdAt: { type: "integer" },
							},
							required: ["conversationId", "messageId", "title", "snippet", "createdAt"],
						},
					},
				},
				required: ["results"],
			},
			StoredKey: {
				type: "object",
				properties: {
					provider: { type: "string", enum: ["openai", "anthropic", "google", "deepseek"] },
					last4: { type: "string" },
					createdAt: { type: "integer", description: "Unix seconds." },
					verifiedAt: { type: ["integer", "null"], description: "Unix seconds, or null if unverified." },
					verified: { type: "boolean" },
				},
				required: ["provider", "last4", "createdAt"],
			},
			KeysResponse: {
				type: "object",
				properties: {
					keys: { type: "array", items: { $ref: "#/components/schemas/StoredKey" } },
				},
				required: ["keys"],
			},
			ModelsResponse: {
				type: "object",
				properties: {
					default: { type: "string" },
					tiers: { type: "array", items: { type: "string" } },
					models: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								label: { type: "string" },
								provider: { type: "string" },
								tier: { type: "string", enum: ["fast", "smart", "reasoning"] },
								billing: { type: "string", enum: ["owner", "user-key"] },
								vision: { type: "boolean" },
								reasoning: { type: "boolean" },
								maxTokens: {
									type: "object",
									properties: { guest: { type: "integer" }, user: { type: "integer" } },
								},
								contextWindow: { type: "integer" },
								access: { type: "string", enum: ["guest", "sign-in", "key-required"] },
							},
							required: ["id", "label", "provider", "tier", "billing", "access"],
						},
					},
				},
				required: ["default", "tiers", "models"],
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
					build: {
						type: ["string", "null"],
						description: "Commit the running Worker was deployed from, or null.",
					},
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
					"With `protocol` 2 and history consent on (the default), the turn is saved " +
					"to the caller's conversation history and the `meta` event carries " +
					"`conversationId`, `userMessageId` (absent on a regenerate) and " +
					"`assistantMessageId`; an id that is not the caller's is a 404. With " +
					"memory consent on, stored facts personalise the reply and new ones are " +
					"learnt in the background. Request bodies are limited to 6 MiB.",
				security: [{ clerkBearer: [] }],
				requestBody: chatBody(false),
				responses: { ...CHAT_RESPONSE, ...UNAUTHORIZED, ...MODEL_FORBIDDEN, ...NOT_FOUND, ...JSON_ERRORS },
			},
		},
		"/api/chat/guest": {
			post: {
				tags: ["chat"],
				operationId: "chatGuest",
				summary: "Streaming chat completion (guest)",
				security: [],
				requestBody: chatBody(true),
				responses: { ...CHAT_RESPONSE, ...MODEL_FORBIDDEN, ...JSON_ERRORS },
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
		"/api/voice/transcribe": transcribePath(true),
		"/api/voice/transcribe/guest": transcribePath(false),
		"/api/voice/speak": speakPath(true),
		"/api/voice/speak/guest": speakPath(false),
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
		"/api/v1/keys": {
			get: {
				tags: ["keys"],
				operationId: "listKeys",
				summary: "Providers the caller has stored a key for",
				description:
					"Returns provider, the key's last four characters and dates. The key " +
					"itself is never returned.",
				security: [{ clerkBearer: [] }],
				responses: {
					"200": {
						description: "The caller's stored keys.",
						content: {
							"application/json": { schema: { $ref: "#/components/schemas/KeysResponse" } },
						},
					},
					...UNAUTHORIZED,
				},
			},
			put: {
				tags: ["keys"],
				operationId: "storeKey",
				summary: "Store the caller's own API key for a provider",
				description:
					"The key is checked with one inference-free call to the provider, then " +
					"stored encrypted. A key the provider rejects is a 422. If the provider " +
					"cannot be reached the key is stored unverified. Replaces any existing key " +
					"for that provider.",
				security: [{ clerkBearer: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									provider: { type: "string", enum: ["openai", "anthropic", "google", "deepseek"] },
									key: { type: "string", maxLength: 512 },
								},
								required: ["provider", "key"],
							},
						},
					},
				},
				responses: {
					"200": {
						description: "Stored.",
						content: {
							"application/json": { schema: { $ref: "#/components/schemas/StoredKey" } },
						},
					},
					"422": {
						description: "Unknown provider, malformed key, or a key the provider rejected.",
						content: { "application/json": { schema: ERROR_SCHEMA } },
					},
					"503": {
						description: "Key storage is not configured on this deployment.",
						content: { "application/json": { schema: ERROR_SCHEMA } },
					},
					...UNAUTHORIZED,
				},
			},
			delete: {
				tags: ["keys"],
				operationId: "deleteKey",
				summary: "Remove the caller's stored key for a provider",
				security: [{ clerkBearer: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									provider: { type: "string", enum: ["openai", "anthropic", "google", "deepseek"] },
								},
								required: ["provider"],
							},
						},
					},
				},
				responses: {
					"200": { description: "Removed." },
					"404": { description: "No key was stored for that provider." },
					...UNAUTHORIZED,
				},
			},
		},
		"/api/v1/consent": {
			get: {
				tags: ["privacy"],
				operationId: "getConsent",
				summary: "What the caller agreed to",
				security: HISTORY_SECURITY,
				responses: { ...jsonOk("The caller's consent, or null if never answered.", "ConsentResponse"), ...HISTORY_ERRORS },
			},
			put: {
				tags: ["privacy"],
				operationId: "putConsent",
				summary: "Record the caller's consent against the current policy version",
				description: "Turning memory off deletes every stored fact in the same request.",
				security: HISTORY_SECURITY,
				requestBody: jsonBody({
					type: "object",
					properties: { history: { type: "boolean" }, memory: { type: "boolean" } },
					required: ["history", "memory"],
				}),
				responses: { ...jsonOk("Stored.", "ConsentResponse"), ...HISTORY_ERRORS },
			},
		},
		"/api/v1/memory": {
			get: {
				tags: ["privacy"],
				operationId: "listMemory",
				summary: "Every fact remembered about the caller",
				security: HISTORY_SECURITY,
				responses: { ...jsonOk("Oldest first.", "MemoryList"), ...HISTORY_ERRORS },
			},
			delete: {
				tags: ["privacy"],
				operationId: "forgetMemory",
				summary: "Forget every fact",
				security: HISTORY_SECURITY,
				responses: { "204": { description: "Forgotten." }, ...HISTORY_ERRORS },
			},
		},
		"/api/v1/memory/{id}": {
			delete: {
				tags: ["privacy"],
				operationId: "forgetFact",
				summary: "Forget one fact",
				security: HISTORY_SECURITY,
				parameters: [ID_PARAM],
				responses: { "204": { description: "Forgotten." }, ...NOT_FOUND, ...HISTORY_ERRORS },
			},
		},
		"/api/v1/conversations": {
			get: {
				tags: ["history"],
				operationId: "listConversations",
				summary: "The caller's conversations, 50 per page",
				security: HISTORY_SECURITY,
				parameters: [
					{
						name: "folder",
						in: "query",
						required: false,
						description: "A folder id, or `none` for conversations in no folder.",
						schema: { type: "string" },
					},
					{ name: "cursor", in: "query", required: false, description: "`nextCursor` from the previous page.", schema: { type: "string" } },
				],
				responses: { ...jsonOk("One page.", "ConversationList"), ...HISTORY_ERRORS },
			},
			post: {
				tags: ["history"],
				operationId: "createConversation",
				summary: "Start an empty conversation",
				security: HISTORY_SECURITY,
				requestBody: {
					required: false,
					content: {
						"application/json": { schema: { type: "object", properties: { title: { type: "string", maxLength: 200 } } } },
					},
				},
				responses: {
					"201": {
						description: "Created.",
						content: { "application/json": { schema: wrapped("conversation", "ConversationSummary") } },
					},
					...HISTORY_ERRORS,
				},
			},
			delete: {
				tags: ["history"],
				operationId: "deleteAllConversations",
				summary: "Delete all of the caller's history for good",
				security: HISTORY_SECURITY,
				responses: { "204": { description: "Deleted." }, ...HISTORY_ERRORS },
			},
		},
		"/api/v1/conversations/{id}": {
			get: {
				tags: ["history"],
				operationId: "getConversation",
				summary: "A conversation with its whole message tree",
				security: HISTORY_SECURITY,
				parameters: [ID_PARAM],
				responses: { ...jsonOk("The conversation.", "ConversationDetail"), ...NOT_FOUND, ...HISTORY_ERRORS },
			},
			patch: {
				tags: ["history"],
				operationId: "updateConversation",
				summary: "Rename, pin, file in a folder, or switch the visible branch",
				security: HISTORY_SECURITY,
				parameters: [ID_PARAM],
				requestBody: jsonBody({
					type: "object",
					properties: {
						title: { type: "string", maxLength: 200 },
						pinned: { type: "boolean" },
						folderId: { type: ["string", "null"], format: "uuid" },
						activeLeafId: { type: "string", format: "uuid", description: "A message in this conversation." },
					},
				}),
				responses: {
					"200": {
						description: "Updated.",
						content: { "application/json": { schema: wrapped("conversation", "ConversationSummary") } },
					},
					...NOT_FOUND,
					...HISTORY_ERRORS,
				},
			},
			delete: {
				tags: ["history"],
				operationId: "deleteConversation",
				summary: "Delete a conversation",
				description: "Soft by default, so it can be undone; `?purge=1` removes it for good.",
				security: HISTORY_SECURITY,
				parameters: [
					ID_PARAM,
					{ name: "purge", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
				],
				responses: { "204": { description: "Deleted." }, ...NOT_FOUND, ...HISTORY_ERRORS },
			},
		},
		"/api/v1/folders": {
			get: {
				tags: ["history"],
				operationId: "listFolders",
				summary: "The caller's folders",
				security: HISTORY_SECURITY,
				responses: {
					"200": {
						description: "Ordered by position.",
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: { folders: { type: "array", items: { $ref: "#/components/schemas/Folder" } } },
									required: ["folders"],
								},
							},
						},
					},
					...HISTORY_ERRORS,
				},
			},
			post: {
				tags: ["history"],
				operationId: "createFolder",
				summary: "Create a folder at the end of the list",
				security: HISTORY_SECURITY,
				requestBody: jsonBody({
					type: "object",
					properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
					required: ["name"],
				}),
				responses: {
					"201": { description: "Created.", content: { "application/json": { schema: wrapped("folder", "Folder") } } },
					...HISTORY_ERRORS,
				},
			},
		},
		"/api/v1/folders/{id}": {
			patch: {
				tags: ["history"],
				operationId: "updateFolder",
				summary: "Rename or move a folder",
				security: HISTORY_SECURITY,
				parameters: [ID_PARAM],
				requestBody: jsonBody({
					type: "object",
					properties: {
						name: { type: "string", minLength: 1, maxLength: 80 },
						position: { type: "integer", minimum: 0 },
					},
				}),
				responses: {
					"200": { description: "Updated.", content: { "application/json": { schema: wrapped("folder", "Folder") } } },
					...NOT_FOUND,
					...HISTORY_ERRORS,
				},
			},
			delete: {
				tags: ["history"],
				operationId: "deleteFolder",
				summary: "Delete a folder; its conversations move to no folder",
				security: HISTORY_SECURITY,
				parameters: [ID_PARAM],
				responses: { "204": { description: "Deleted." }, ...NOT_FOUND, ...HISTORY_ERRORS },
			},
		},
		"/api/v1/search": {
			get: {
				tags: ["history"],
				operationId: "searchHistory",
				summary: "Full-text search over the caller's saved messages",
				description:
					"Each word matches as a prefix. Arabic diacritics and Latin accents are " +
					"ignored. At most 20 results, newest first; deleted conversations are left out.",
				security: HISTORY_SECURITY,
				parameters: [
					{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } },
				],
				responses: { ...jsonOk("Matches.", "HistorySearchResponse"), ...HISTORY_ERRORS },
			},
		},
		"/api/v1/models": {
			get: {
				tags: ["meta"],
				operationId: "listModels",
				summary: "Models the chat endpoint can run",
				description:
					"Static and inference-free. Each entry's `access` says what a caller " +
					"needs: `guest` for anyone, `sign-in` for a bearer token, `key-required` " +
					"for the caller's own provider key. Filter with `?tier=fast|smart|reasoning`.",
				security: [],
				parameters: [
					{
						name: "tier",
						in: "query",
						required: false,
						schema: { type: "string", enum: ["fast", "smart", "reasoning"] },
					},
				],
				responses: {
					"200": {
						description: "The model listing.",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ModelsResponse" },
							},
						},
					},
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

/**
 * The health document. `build` is the commit the Worker was deployed from,
 * stamped by scripts/deploy.mjs; null on a dev server or a deploy made
 * without it. scripts/verify-deploy.mjs compares it to the local HEAD.
 */
export function buildHealth(env: { BUILD_SHA?: string }) {
	return {
		status: "ok",
		version: API_VERSION,
		service: "eleenai",
		build: env.BUILD_SHA ?? null,
		capabilities: ["chat", "image-generation", "vision", "web-search", "mcp"],
	} as const;
}
