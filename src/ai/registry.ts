/**
 * The model registry: the one list of models EleenAI can run, with everything
 * the rest of the Worker needs to know about each.
 *
 * Replaces the hardcoded model IDs that used to be spread across index.ts.
 * Every public surface that names a model — /api/v1/models, the chat body's
 * `model` field, the MCP chat tool's `tier` argument, the guard's
 * infrastructure terms — reads from here, so adding a model is one entry.
 *
 * Billing follows the decision recorded for M3.4:
 *   - `owner`    Workers AI models paid for by the owner, metered by the
 *                gateway and the rate limiter. Guests may use them.
 *   - `user-key` Third-party models that run only with the caller's own
 *                provider key. Until the key store ships they are listed as
 *                locked and refused before any provider call.
 */

import type { Billing, ModelTier, Provider, ReasoningFormat } from "../shared/models";

// Defined in src/shared/ so the browser can use them; re-exported so Worker
// code keeps importing from the registry.
export type { Billing, ModelTier, Provider, ReasoningFormat } from "../shared/models";

export interface ModelSpec {
	/** Public identifier. Clients send this as `model`. Also the gateway's name. */
	id: string;
	/** Short display name. */
	label: string;
	provider: Provider;
	tier: ModelTier;
	billing: Billing;
	/** Accepts image parts in a user turn. */
	vision: boolean;
	reasoning: ReasoningFormat;
	/** Output caps by caller tier. The guest cap is the published 512. */
	maxTokens: { guest: number; user: number };
	/** Reserved for the picker's sorting; not enforced server-side. */
	contextWindow: number;
}

/**
 * Workers AI entries were checked against `wrangler ai models list` on
 * 2026-10-16. The Fast model is pinned: it is the model every v1 client has
 * always received, and the v1 stream contract is byte-identical to before.
 */
export const MODELS: readonly ModelSpec[] = [
	{
		id: "@cf/meta/llama-3.1-8b-instruct-fp8",
		label: "Llama 3.1 8B",
		provider: "workers-ai",
		tier: "fast",
		billing: "owner",
		vision: false,
		reasoning: "none",
		maxTokens: { guest: 512, user: 1024 },
		contextWindow: 32_000,
	},
	{
		id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		label: "Llama 3.3 70B",
		provider: "workers-ai",
		tier: "smart",
		billing: "owner",
		vision: false,
		reasoning: "none",
		maxTokens: { guest: 512, user: 1536 },
		contextWindow: 24_000,
	},
	{
		id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
		label: "DeepSeek R1 32B",
		provider: "workers-ai",
		tier: "reasoning",
		billing: "owner",
		vision: false,
		reasoning: "think-tags",
		// Thinking eats the budget, and guests are capped at 512 by the
		// published contract, so the tier is for signed-in users only.
		maxTokens: { guest: 0, user: 4096 },
		contextWindow: 80_000,
	},
	// Third-party models run only with the caller's own key (M3.4 part two).
	// Listed so the picker can show them locked; refused before any call.
	// IDs use the gateway's `provider/model` form; each is confirmed against
	// a real call when the key store lands.
	{
		id: "openai/gpt-5.5",
		label: "GPT-5.5",
		provider: "openai",
		tier: "smart",
		billing: "user-key",
		vision: true,
		reasoning: "field",
		maxTokens: { guest: 0, user: 4096 },
		contextWindow: 400_000,
	},
	{
		id: "anthropic/claude-sonnet-5-5",
		label: "Claude Sonnet 5.5",
		provider: "anthropic",
		tier: "smart",
		billing: "user-key",
		vision: true,
		reasoning: "field",
		maxTokens: { guest: 0, user: 4096 },
		contextWindow: 200_000,
	},
	{
		id: "anthropic/claude-opus-5-5",
		label: "Claude Opus 5.5",
		provider: "anthropic",
		tier: "reasoning",
		billing: "user-key",
		vision: true,
		reasoning: "field",
		maxTokens: { guest: 0, user: 8192 },
		contextWindow: 200_000,
	},
];

const BY_ID: ReadonlyMap<string, ModelSpec> = new Map(MODELS.map((m) => [m.id, m]));

/** The model a tier name resolves to: the first owner-billed entry for it. */
export function defaultForTier(tier: ModelTier): ModelSpec {
	const spec = MODELS.find((m) => m.tier === tier && m.billing === "owner");
	if (!spec) throw new Error(`No owner-billed model for tier ${tier}`);
	return spec;
}

/** The model used when a request names none: the pinned Fast model. */
export const DEFAULT_MODEL: ModelSpec = defaultForTier("fast");

/**
 * The model for internal utility calls (prompt enhancement, memory summaries).
 * Always the cheap owner-billed Fast model, whatever the user picked for chat.
 */
export const UTILITY_MODEL: ModelSpec = DEFAULT_MODEL;

export const TIERS: readonly ModelTier[] = ["fast", "smart", "reasoning"];

export function isTier(value: unknown): value is ModelTier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/**
 * Resolve what a client sent as `model`: a full model id, a tier name, or
 * nothing. Returns null for an id the registry does not know, so the caller
 * can answer 422 rather than forwarding an arbitrary string to a provider.
 */
export function resolveModel(requested: unknown): ModelSpec | null {
	if (requested === undefined || requested === null || requested === "") return DEFAULT_MODEL;
	if (isTier(requested)) return defaultForTier(requested);
	if (typeof requested !== "string") return null;
	return BY_ID.get(requested) ?? null;
}

/**
 * Whether this caller may run this model at all, before any key lookup. A
 * user-key model additionally needs a stored key, which the chat handler
 * checks against the key store (src/lib/keys.ts).
 */
export function canUse(spec: ModelSpec, userId: string): boolean {
	if (userId === "guest") return spec.billing === "owner" && spec.maxTokens.guest > 0;
	return true;
}

/**
 * Output cap for a caller on a model. An optional ceiling lets a caller such
 * as the MCP tool lower it further; it can never raise it.
 */
export function outputCap(spec: ModelSpec, userId: string, ceiling?: number): number {
	const own = userId === "guest" ? spec.maxTokens.guest : spec.maxTokens.user;
	return ceiling === undefined ? own : Math.min(own, ceiling);
}

/**
 * Model identifiers that must never appear in a reply. Derived here so the
 * guard cannot drift from the registry when a model is added.
 */
export function modelIdentifiers(): string[] {
	return MODELS.map((m) => m.id.toLowerCase());
}
