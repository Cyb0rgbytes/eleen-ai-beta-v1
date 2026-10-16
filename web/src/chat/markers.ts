/**
 * The control markers the system prompt asks the model to emit:
 *   [SUGGEST]a|b|c[/SUGGEST]   follow-up suggestions, shown as chips
 *   [IMG_GEN]prompt[/IMG_GEN]  an image request (the closing slash is often
 *                              forgotten, so [IMG_GEN] closes it too)
 *   [TOOL:think] etc.          activity hints at the start of a reply
 *
 * They are stripped from the displayed text. Their contents are model
 * output like everything else and are only ever used as text.
 */

const SUGGEST = /\[SUGGEST\]([\s\S]*?)\[\/SUGGEST\]/g;
const IMG_GEN = /\[IMG_GEN\]([\s\S]*?)\[\/?IMG_GEN\]/g;
const TOOL = /\[TOOL:(think|search|vision|generate)\]\s*/g;
const MARKER_NAMES = ["SUGGEST", "IMG_GEN", "TOOL:"];

/**
 * Cut a marker that is still streaming in, so it never flashes on screen:
 * an opened [SUGGEST] or [IMG_GEN] with no closing tag yet, a [TOOL: hint
 * not yet closed, or a trailing "[" plus any prefix of a marker name.
 */
function stripOpenTail(text: string): string {
	const open = text.search(/\[(?:SUGGEST|IMG_GEN)\](?![\s\S]*\[\/?(?:SUGGEST|IMG_GEN)\])[\s\S]*$/);
	if (open >= 0) return text.slice(0, open);
	const bracket = text.lastIndexOf("[");
	if (bracket < 0) return text;
	const tail = text.slice(bracket + 1);
	if (tail.includes("]")) return text;
	const partial = MARKER_NAMES.some((name) => name.startsWith(tail) || (name === "TOOL:" && tail.startsWith("TOOL:")));
	return partial ? text.slice(0, bracket) : text;
}

export const MAX_SUGGESTIONS = 3;
export const MAX_SUGGESTION_CHARS = 120;

export interface Extracted {
	text: string;
	suggestions: string[];
	imagePrompt: string | null;
}

export function extractMarkers(raw: string, { streaming = false } = {}): Extracted {
	const suggestions: string[] = [];
	let imagePrompt: string | null = null;

	let text = raw.replace(SUGGEST, (_m, inner: string) => {
		for (const part of inner.split("|")) {
			const s = part.trim().slice(0, MAX_SUGGESTION_CHARS);
			if (s && suggestions.length < MAX_SUGGESTIONS) suggestions.push(s);
		}
		return "";
	});
	text = text.replace(IMG_GEN, (_m, inner: string) => {
		if (imagePrompt === null && inner.trim()) imagePrompt = inner.trim();
		return "";
	});
	text = text.replace(TOOL, "");
	if (streaming) text = stripOpenTail(text);

	return { text: text.trim(), suggestions, imagePrompt };
}
