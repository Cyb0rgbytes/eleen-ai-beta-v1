/**
 * Response security headers.
 *
 * Applied to every response the Worker emits, including static assets served
 * through env.ASSETS.
 *
 * CSP ships Report-Only for now. The current frontend still has two inline
 * <script> blocks in public/index.html and interpolated onclick attributes in
 * public/chat.js, so an enforcing policy would break the site. Report-Only
 * collects the violations that the frontend rebuild has to fix before the
 * policy can be switched to enforcing.
 */

/** Origins the page legitimately loads from today. */
const SCRIPT_SOURCES = [
	"'self'",
	"https://unpkg.com", // Spline viewer
	"https://cdnjs.cloudflare.com", // Font Awesome
	"https://*.clerk.accounts.dev",
	"https://clerk.eleenai.xyz",
	"https://challenges.cloudflare.com", // Clerk bot protection
];

const CONNECT_SOURCES = [
	"'self'",
	"https://assets.eleenai.xyz",
	"https://*.clerk.accounts.dev",
	"https://clerk.eleenai.xyz",
	"https://unpkg.com",
];

const CSP_DIRECTIVES = [
	"default-src 'self'",
	`script-src ${SCRIPT_SOURCES.join(" ")} 'unsafe-inline' 'unsafe-eval'`,
	// <spline-viewer> injects styles into its shadow DOM, and hash-pinning
	// those across viewer versions is not maintainable.
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
	"font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
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
