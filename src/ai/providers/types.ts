/**
 * The shape every chat provider implements.
 */
import { ChatMessage } from "../../types";
import { ModelSpec } from "../registry";

export interface ProviderRequest {
	messages: ChatMessage[];
	maxTokens: number;
	/** Label for the gateway log: "chat", "mcp", … */
	route: string;
	/** The caller's own provider key. Required for user-key models. */
	userKey?: string;
	/**
	 * Images for the newest user turn (M5.2). Only ever set for a model whose
	 * registry entry has `vision`; other models get a text description instead.
	 */
	images?: ImagePart[];
}

/** An uploaded image, base64, for a vision model. */
export interface ImagePart {
	mimeType: string;
	data: string;
}

export interface ChatRun {
	/** The provider's raw SSE bytes. */
	stream: ReadableStream<Uint8Array>;
	spec: ModelSpec;
}

/** Thrown before any provider call when a user-key model has no key. */
export class KeyRequiredError extends Error {
	constructor(public readonly spec: ModelSpec) {
		super(`${spec.label} requires your own ${spec.provider} API key.`);
		this.name = "KeyRequiredError";
	}
}
