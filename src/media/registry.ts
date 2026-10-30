/**
 * What Studio sells: the one list of paid models, read only by the Worker.
 *
 * A client names a model by `id`, and nothing else from the client reaches
 * fal except the prompt, so an unlisted model or option can't be requested.
 *
 * Prices are from each model's page at fal's standard rate, never a
 * promotional one. `costMicros` allows for 5.7 s, as fal can return about 0.7 s
 * more than asked for. Credits are that cost × 233, rounded up to a clean
 * figure, which keeps at least 40% margin at the cheapest credit price.
 *
 * Nothing here may reach src/shared/ or /api/v1/models: `costMicros` is the
 * owner's margin. publicModels() is the only view that leaves the Worker.
 */

export interface MediaModel {
	id: string;
	label: string;
	/** fal endpoint id, copied exactly. */
	endpoint: string;
	/** Fixed provider inputs: each model has its own schema, so these are not shared. */
	input: Record<string, string | number>;
	credits: number;
	costMicros: number;
}

const CLIP_768P = { duration: 5, resolution: "768P", aspect_ratio: "16:9", prompt_expansion_mode: "disabled" };

export const MEDIA_MODELS: readonly MediaModel[] = [
	{
		id: "h3-max-turbo",
		label: "H3 Max Turbo",
		endpoint: "minimax/h3-max-turbo/text-to-video",
		input: CLIP_768P,
		credits: 55, // $0.04/s at 768P
		costMicros: 228_000,
	},
	{
		id: "h3-max",
		label: "H3 Max",
		endpoint: "minimax/h3-max/text-to-video",
		input: CLIP_768P,
		credits: 110, // $0.08/s at 768P
		costMicros: 456_000,
	},
];

export function mediaModel(id: unknown): MediaModel | null {
	return MEDIA_MODELS.find((model) => model.id === id) ?? null;
}

/** The picker's view of the list. */
export function publicModels() {
	return MEDIA_MODELS.map(({ id, label, credits }) => ({ id, label, credits }));
}
