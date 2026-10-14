/**
 * Item 4 — Accept: text/markdown negotiation.
 *
 * https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/
 *
 * Hand-rolled rather than using the zone-level Cloudflare feature, which is a
 * paid-plan toggle. If the zone is upgraded, this module can be deleted and
 * the dashboard setting used instead.
 */

/**
 * Parse an Accept header into media type -> quality value.
 *
 * Malformed q values are treated as 1 (the RFC 9110 default) rather than
 * discarded, so a slightly wrong header still negotiates instead of failing.
 */
export function parseAccept(header: string | null): Map<string, number> {
	const result = new Map<string, number>();
	if (!header) return result;

	for (const part of header.split(",")) {
		const [rawType, ...params] = part.split(";");
		const type = rawType.trim().toLowerCase();
		if (!type) continue;

		let q = 1;
		for (const param of params) {
			const [key, value] = param.split("=");
			if (key?.trim().toLowerCase() === "q") {
				const parsed = Number.parseFloat(value ?? "");
				if (Number.isFinite(parsed)) q = parsed;
			}
		}

		// Keep the highest q if a type is listed more than once.
		result.set(type, Math.max(result.get(type) ?? 0, q));
	}

	return result;
}

/**
 * Decide whether to serve markdown for this request.
 *
 * Markdown wins only on a strict preference. A browser sending
 * `text/html,...,*​/*;q=0.8` must keep getting HTML, so the wildcard
 * contributes its q to both sides and ties resolve to HTML.
 */
export function prefersMarkdown(header: string | null): boolean {
	if (!header) return false;

	const accept = parseAccept(header);
	const wildcard = accept.get("*/*") ?? 0;
	const textWildcard = accept.get("text/*") ?? 0;
	const fallback = Math.max(wildcard, textWildcard);

	const md = Math.max(accept.get("text/markdown") ?? 0, accept.get("text/x-markdown") ?? 0, fallback);
	const html = Math.max(accept.get("text/html") ?? 0, accept.get("application/xhtml+xml") ?? 0, fallback);

	return md > html;
}
