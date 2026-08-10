/**
 * CORS for /api/*.
 *
 * There was previously no preflight handler and no CORS headers on any API
 * route, so a browser on any other origin simply could not call the API. The
 * allowlist keeps that from becoming a blanket wildcard: these endpoints spend
 * inference budget, so drive-by cross-origin use is worth preventing even
 * though CORS is not itself an authentication mechanism.
 */

const ALLOWED_ORIGINS = new Set([
	"https://eleenai.xyz",
	"https://www.eleenai.xyz",
	"https://assets.eleenai.xyz",
]);

/** Local dev servers, allowed only when not running in production. */
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isAllowedOrigin(origin: string | null, isProduction: boolean): boolean {
	if (!origin) return false;
	if (ALLOWED_ORIGINS.has(origin)) return true;
	return !isProduction && DEV_ORIGIN.test(origin);
}

export function corsHeaders(origin: string | null, isProduction: boolean): Record<string, string> {
	if (!isAllowedOrigin(origin, isProduction)) return {};

	return {
		"Access-Control-Allow-Origin": origin as string,
		"Access-Control-Allow-Credentials": "true",
		// Reflecting a single origin makes the response origin-dependent, so it
		// must not be cached and served to a different one.
		Vary: "Origin",
	};
}

/** Preflight response. Returns null when this is not a preflight request. */
export function handlePreflight(request: Request, isProduction: boolean): Response | null {
	if (request.method !== "OPTIONS") return null;
	if (!request.headers.get("access-control-request-method")) return null;

	const origin = request.headers.get("origin");
	if (!isAllowedOrigin(origin, isProduction)) {
		// No CORS headers: the browser rejects it, which is the correct answer.
		return new Response(null, { status: 403 });
	}

	return new Response(null, {
		status: 204,
		headers: {
			...corsHeaders(origin, isProduction),
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "content-type, authorization",
			"Access-Control-Max-Age": "86400",
		},
	});
}
