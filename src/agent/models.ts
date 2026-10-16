/**
 * The public model listing served at /api/v1/models.
 *
 * Built from the registry so the picker, agents and the chat validator can
 * never disagree about which ids exist. Costs no inference, so it sits beside
 * /api/v1/health above the auth gate.
 */
import { DEFAULT_MODEL, MODELS, ModelSpec, TIERS, isTier } from "../ai/registry";
import type { ModelAccess, ModelsDocument } from "../shared/models";

export type { ModelAccess, ModelsDocument, PublicModel } from "../shared/models";

function accessFor(spec: ModelSpec): ModelAccess {
	if (spec.billing === "user-key") return "key-required";
	return spec.maxTokens.guest > 0 ? "guest" : "sign-in";
}

export function buildModelsDocument(tier?: unknown): ModelsDocument {
	const filter = isTier(tier) ? tier : null;
	return {
		default: DEFAULT_MODEL.id,
		tiers: TIERS,
		models: MODELS.filter((m) => !filter || m.tier === filter).map((m) => ({
			id: m.id,
			label: m.label,
			provider: m.provider,
			tier: m.tier,
			billing: m.billing,
			vision: m.vision,
			reasoning: m.reasoning !== "none",
			maxTokens: m.maxTokens,
			contextWindow: m.contextWindow,
			access: accessFor(m),
		})),
	};
}
