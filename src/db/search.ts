/**
 * Search text for the messages_fts index (migrations/0003_core.sql).
 *
 * The index is built over messages.search_text, and a query is matched
 * against it, so both go through normalizeForSearch: whatever the writer
 * typed, "مرحبا" finds "مَرْحَبًا" and "café" finds "cafe" (the tokenizer
 * folds Latin accents itself).
 */

/** Arabic tashkeel (harakat, tanwin, shadda, sukun, superscript alef) and tatweel. */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

export function normalizeForSearch(text: string): string {
	return text
		.normalize("NFKC")
		.replace(ARABIC_MARKS, "")
		.replace(/[آأإٱ]/g, "ا") // alef with hamza or madda -> bare alef
		.replace(/ى/g, "ي") // alef maqsura -> ya
		.replace(/ة/g, "ه") // ta marbuta -> ha
		.toLowerCase();
}

/**
 * A safe FTS5 MATCH expression from what the user typed: each word becomes
 * a quoted prefix term, so FTS5 operators and quotes in the input are text,
 * never syntax. Returns null when nothing searchable is left.
 */
export function toMatchQuery(input: string): string | null {
	const words = normalizeForSearch(input)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
		.slice(0, 8);
	if (!words.length) return null;
	return words.map((word) => `"${word.replace(/"/g, "")}"*`).join(" ");
}
