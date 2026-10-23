/**
 * Headers for the installable-app files (M5.5). wrangler.jsonc routes these
 * paths through the Worker (run_worker_first), so they get the security
 * headers like every Worker response, and this sets what the asset server
 * would not:
 *
 * - /manifest.webmanifest: application/manifest+json, cached for an hour.
 * - /sw.js: revalidated on every load (no-cache). Browsers already cap a
 *   worker script's HTTP cache at 24 hours; no-cache makes a deploy's new
 *   worker reach readers on their next visit.
 * - /offline: the worker's fallback page, revalidated like the worker.
 */
const RULES: Record<string, { type?: string; cache: string }> = {
	"/manifest.webmanifest": { type: "application/manifest+json; charset=utf-8", cache: "public, max-age=3600" },
	"/sw.js": { type: "text/javascript; charset=utf-8", cache: "no-cache" },
	"/offline": { cache: "no-cache" },
	"/offline.html": { cache: "no-cache" },
};

export function isPwaPath(pathname: string): boolean {
	return Object.prototype.hasOwnProperty.call(RULES, pathname);
}

/** A copy of an asset response for one of the paths above, with its headers set. */
export function withPwaHeaders(pathname: string, response: Response): Response {
	const rule = RULES[pathname];
	if (!rule || !response.ok) return response;
	const result = new Response(response.body, response);
	if (rule.type) result.headers.set("Content-Type", rule.type);
	result.headers.set("Cache-Control", rule.cache);
	return result;
}
