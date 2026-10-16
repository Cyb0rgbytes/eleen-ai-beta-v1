/**
 * Response security headers.
 *
 * Applied to every response the Worker emits, including static assets served
 * through env.ASSETS.
 *
 * CSP ships Report-Only. Since the M3.5 rebuild the page has no inline
 * script and no inline handler: every script of ours is a hashed same-origin
 * module, so script-src no longer carries 'unsafe-inline' or 'unsafe-eval'.
 * The policy goes enforcing after 48 hours of clean reports (M3.6).
 */

/** Every script origin the page loads. Pinned by e2e/chat.spec.ts. */
const SCRIPT_SOURCES = [
	"'self'",
	"https://unpkg.com", // Spline viewer 1.12.88: no licence to self-host it
	"https://clerk.eleenai.xyz", // Clerk SDK, production frontend API
	"https://cdn.protect.clerk.com", // Clerk Protect bot-detection bootstrap
	"https://challenges.cloudflare.com", // Turnstile inside Clerk's sign-in
];

const CONNECT_SOURCES = [
	"'self'",
	"https://assets.eleenai.xyz", // the scene
	"https://unpkg.com", // the viewer's own sub-modules
	"https://clerk.eleenai.xyz",
	// Clerk Protect probes per-instance hosts, some on non-standard ports.
	"https://*.protect.clerk.com",
	"https://*.client.protect.clerk.com:*",
];

const CSP_DIRECTIVES = [
	"default-src 'self'",
	// 'unsafe-eval' is the Spline viewer's requirement, not ours: its bundle
	// evaluates a string at build/spline-viewer.js:3175 (measured with a
	// securitypolicyviolation listener, 2026-10-17). Nothing in web/src uses
	// eval. Removing it means isolating the viewer in its own document.
	// 'unsafe-inline' is gone: the page has no inline script or handler.
	`script-src ${SCRIPT_SOURCES.join(" ")} 'unsafe-eval'`,
	// <spline-viewer> injects styles into its shadow DOM and Clerk injects
	// its own <style> elements; hash-pinning either across versions is not
	// maintainable.
	"style-src 'self' 'unsafe-inline'",
	// Self-hosted WOFF2 under /fonts/ only (M3.5).
	"font-src 'self'",
	// blob: and data: are required for generated images.
	"img-src 'self' data: blob: https:",
	`connect-src ${CONNECT_SOURCES.join(" ")}`,
	// WebGL workers for the Spline scene.
	"worker-src 'self' blob:",
	"child-src 'self' blob:",
	"frame-src 'self' https://challenges.cloudflare.com",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"upgrade-insecure-requests",
	"report-uri /api/csp-report",
];

const CSP = CSP_DIRECTIVES.join("; ");

const BASE_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Cross-Origin-Opener-Policy": "same-origin",
	// microphone=(self) is deliberate — the voice input work in a later phase
	// needs it, and adding it now avoids a second pass over these headers.
	"Permissions-Policy":
		"accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), " +
		"microphone=(self), payment=(), usb=()",
	"Content-Security-Policy-Report-Only": CSP,
};

/**
 * HSTS is only meaningful over TLS, and asserting it from a local dev server
 * would pin localhost to HTTPS in the developer's browser — a genuinely
 * annoying thing to undo.
 */
function hstsApplies(url: URL): boolean {
	return url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
}

/**
 * Return a copy of `response` carrying the security headers.
 *
 * Existing values are not overwritten: a handler that deliberately set its own
 * policy (the R2 asset branch, the MCP CORS headers) keeps it.
 */
export function withSecurityHeaders(response: Response, url: URL): Response {
	const result = new Response(response.body, response);

	for (const [name, value] of Object.entries(BASE_HEADERS)) {
		if (!result.headers.has(name)) result.headers.set(name, value);
	}

	if (hstsApplies(url) && !result.headers.has("Strict-Transport-Security")) {
		result.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	}

	return result;
}
