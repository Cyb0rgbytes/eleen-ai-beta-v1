/**
 * Response helpers shared by the agent-readiness surfaces.
 *
 * These exist to keep one consistent policy for content types, caching and
 * HEAD handling across a dozen small routes, rather than hand-rolling headers
 * at each one.
 */

/** Cache policy for documents that are stable between deploys. */
export const CACHE_STABLE = "public, max-age=3600";

/**
 * Cache policy for content-negotiated responses.
 *
 * Cloudflare's edge cache ignores `Vary` on everything except
 * `Accept-Encoding`. A negotiated resource that is cacheable would therefore
 * have one variant stored and served to everyone — markdown to browsers, or
 * HTML to agents. `no-store` is the only safe policy for those routes; stable
 * cacheable copies are published at distinct URLs (/index.md, /docs.md).
 */
export const CACHE_NEGOTIATED = "private, no-store";

/**
 * Build a response, dropping the body for HEAD.
 *
 * Per RFC 9110 a HEAD response carries the headers the GET would have,
 * including `Content-Length`, but no body.
 */
export function body(
	request: Request,
	content: string,
	contentType: string,
	extraHeaders: Record<string, string> = {},
	status = 200,
): Response {
	const headers = new Headers();
	// An empty value means "suppress this header" — it lets a caller opt out of
	// a default set by a wrapper (e.g. markdown()'s Vary) without a second
	// parameter. An actually-empty header would be meaningless anyway.
	for (const [key, value] of Object.entries(extraHeaders)) {
		if (value !== "") headers.set(key, value);
	}
	headers.set("content-type", contentType);

	if (!headers.has("cache-control")) {
		headers.set("cache-control", CACHE_STABLE);
	}

	// Byte length, not string length — multi-byte characters would otherwise
	// under-report and truncate the response for clients that trust it.
	headers.set("content-length", String(new TextEncoder().encode(content).byteLength));

	return new Response(request.method === "HEAD" ? null : content, { status, headers });
}

/** JSON document with a caller-chosen media type (linkset+json, etc). */
export function json(
	request: Request,
	value: unknown,
	contentType = "application/json; charset=utf-8",
	extraHeaders: Record<string, string> = {},
	status = 200,
): Response {
	return body(request, JSON.stringify(value, null, 2) + "\n", contentType, extraHeaders, status);
}

/** Markdown document. Always advertises `Vary: Accept`. */
export function markdown(
	request: Request,
	content: string,
	extraHeaders: Record<string, string> = {},
): Response {
	return body(request, content, "text/markdown; charset=utf-8", {
		vary: "Accept",
		"x-markdown-tokens": String(estimateTokens(content)),
		...extraHeaders,
	});
}

/**
 * Rough token count for the `x-markdown-tokens` hint.
 *
 * This is a chars/4 approximation, not a real tokenization — the header is
 * advisory, letting an agent budget a fetch before making it. Callers should
 * compute it once at module scope, not per request.
 */
export function estimateTokens(content: string): number {
	return Math.ceil(content.length / 4);
}

/** 405 with the mandatory `Allow` header. */
export function methodNotAllowed(allow: string): Response {
	return new Response(null, { status: 405, headers: { allow } });
}

/** True for the read-only methods every metadata document supports. */
export function isRead(request: Request): boolean {
	return request.method === "GET" || request.method === "HEAD";
}
