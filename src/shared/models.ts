/**
 * Model listing types shared by the Worker and the browser.
 *
 * src/ai/registry.ts holds the models themselves; /api/v1/models serves a
 * ModelsDocument built from it, and the picker reads that document.
 */

export type Provider = "workers-ai" | "openai" | "anthropic" | "google" | "deepseek";

/** Speed/quality tiers shown in the picker. */
export type ModelTier = "fast" | "smart" | "reasoning";

export type Billing = "owner" | "user-key";

/**
 * How a model surfaces its chain of thought, if at all.
 *   - `none`       Plain text only.
 *   - `think-tags` Reasoning arrives inline as `<think>…</think>` and must be
 *                  split out of the text (DeepSeek R1 distills, QwQ).
 *   - `field`      Reasoning arrives in a separate `reasoning_content` delta
 *                  (OpenAI-compatible providers).
 */
export type ReasoningFormat = "none" | "think-tags" | "field";

/** What a caller needs before a model will answer. */
export type ModelAccess = "guest" | "sign-in" | "key-required";

export interface PublicModel {
	id: string;
	label: string;
	provider: Provider;
	tier: ModelTier;
	billing: Billing;
	vision: boolean;
	/** True when the model emits a chain of thought the v2 stream can carry. */
	reasoning: boolean;
	maxTokens: { guest: number; user: number };
	contextWindow: number;
	access: ModelAccess;
}

export interface ModelsDocument {
	default: string;
	tiers: readonly ModelTier[];
	models: PublicModel[];
}
