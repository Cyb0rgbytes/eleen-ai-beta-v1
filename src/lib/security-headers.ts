/**
 * Response security headers.
 *
 * Applied to every response the Worker emits, including static assets served
 * through env.ASSETS.
 *
 * CSP ships Report-Only. Since the M3.5 rebuild the page has no inline
 * script and no inline handler: every script of ours is a hashed same-origin
 * module, so script-src no longer carries 'unsafe-inline'. 'unsafe-eval'
 * stays for the Spline viewer (see script-src below). The policy goes
 * enforcing after 48 hours of clean reports (M3.6); Trusted Types stays
 * Report-Only as a separate policy.
 */

/** Every script origin the page loads. Pinned by e2e/chat.spec.ts. */
const SCRIPT_SOURCES = [
	"'self'",
	"https://unpkg.com", // Spline viewer 1.12.88: no licence to self-host it
	"https://clerk.eleenai.xyz", // Clerk SDK, production frontend API
	"https://cdn.protect.clerk.com", // Clerk Protect bot-detection bootstrap
	// The bootstrap then loads loader.js from a fresh random subdomain on each
	// visit (four in the 2026-10-17 to 10-21 reports), so only a wildcard fits.
	"https://*.client.protect.clerk.com",
	"https://challenges.cloudflare.com", // Turnstile inside Clerk's sign-in
	// Web Analytics: the zone injects an external beacon tag into the page.
	"https://static.cloudflareinsights.com",
];

const CONNECT_SOURCES = [
	"'self'",
	"https://assets.eleenai.xyz", // the scene
	"https://unpkg.com", // the viewer's own sub-modules
	// The viewer fetches the scene's text fonts itself, from Google's font
	// CDN (measured in the 2026-10-16 sweep). The page's own fonts stay
	// self-hosted under font-src 'self'.
	"https://fonts.gstatic.com",
	"https://clerk.eleenai.xyz",
	// Clerk Protect probes per-instance hosts, some on non-standard ports.
	"https://*.protect.clerk.com",
	"https://*.client.protect.clerk.com:*",
	// Where the Web Analytics beacon posts page-view timings.
	"https://cloudflareinsights.com",
];

/**
 * The policy, with an optional per-response nonce in script-src.
 *
 * The nonce exists for one script: the zone's JavaScript Detections
 * (Bot Fight Mode, which cannot turn it off) injects an inline script into
 * every HTML page. Cloudflare reads the nonce from this header and stamps
 * it on that script, so it runs while every other inline script stays
 * blocked. Our own scripts are same-origin files and never need it.
 */
function cspDirectives(nonce?: string): string[] {
	const scripts = nonce ? [...SCRIPT_SOURCES, `'nonce-${nonce}'`] : SCRIPT_SOURCES;
	return [
		"default-src 'self'",
		// 'unsafe-eval' is the Spline viewer's requirement, not ours: its bundle
		// evaluates a string at build/spline-viewer.js:3175 (measured with a
		// securitypolicyviolation listener, 2026-10-17). Nothing in web/src uses
		// eval. Removing it means isolating the viewer in its own document.
		// 'unsafe-inline' is gone: the page has no inline script or handler.
		`script-src ${scripts.join(" ")} 'unsafe-eval'`,
		// <spline-viewer> injects styles into its shadow DOM and Clerk injects
		// its own <style> elements; hash-pinning either across versions is not
		// maintainable.
		"style-src 'self' 'unsafe-inline'",
		// Self-hosted WOFF2 under /fonts/ only (M3.5).
		"font-src 'self'",
		// blob: and data: carry generated images. No longer "https:": an open
		// image source lets injected markup exfiltrate by URL. The only remote
		// images are Clerk avatars and the Spline viewer's badge.
		"img-src 'self' data: blob: https://img.clerk.com https://app.spline.design",
		`connect-src ${CONNECT_SOURCES.join(" ")}`,
		// Spoken replies play from a blob: URL made from /api/voice/speak.
		"media-src 'self' blob:",
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
}

/** The policy for HTML documents: a fresh, unguessable nonce every time. */
function htmlCsp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const nonce = btoa(String.fromCharCode(...bytes));
	return cspDirectives(nonce).join("; ");
}

const CSP = cspDirectives().join("; ");

/**
 * Trusted Types, as its own policy so it can stay Report-Only after the main
 * CSP goes enforcing. Our one sink (the viewer's script URL) goes through
 * the "eleenai-scene" policy in web/src/scene/spline.ts; Clerk's bundle and
 * the Spline viewer still assign raw strings, so enforcing this would break
 * sign-in and the scene.
 *
 * It has no report-uri. Measured on production on 2026-10-17, one page load
 * sent about 30 Trusted Types reports, all from Clerk and the Spline viewer.
 * Every one was a Worker request, and together they buried the main policy's
 * reports, which are the ones that decide the enforcing flip. The violations
 * still show in the browser console.
 */
export const TRUSTED_TYPES_POLICY = "require-trusted-types-for 'script'";

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

	const ownReportOnly = !result.headers.has("Content-Security-Policy-Report-Only");
	// Only documents get a nonce; scripts, styles and API answers keep the
	// fixed policy (a nonce means nothing there).
	if (ownReportOnly && (result.headers.get("Content-Type") ?? "").startsWith("text/html")) {
		result.headers.set("Content-Security-Policy-Report-Only", htmlCsp());
	}
	for (const [name, value] of Object.entries(BASE_HEADERS)) {
		if (!result.headers.has(name)) result.headers.set(name, value);
	}
	// A second policy in the same header: browsers evaluate each separately.
	if (ownReportOnly) result.headers.append("Content-Security-Policy-Report-Only", TRUSTED_TYPES_POLICY);

	if (hstsApplies(url) && !result.headers.has("Strict-Transport-Security")) {
		result.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	}

	return result;
}
