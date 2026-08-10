/**
 * Items 5, 6, 7 — API catalog and OAuth/OIDC discovery metadata.
 *
 * RFC 9727 (API catalog) · RFC 9264 (linkset) · RFC 9728 (protected resource)
 */
import { Env } from "../types";
import { ORIGIN, absolute, clerkIssuer } from "./config";

// ─── Item 5: /.well-known/api-catalog ────────────────────────────────────────

/**
 * The media type is load-bearing. A catalog served as `application/json`
 * fails RFC 9727 validation even when the body is byte-identical.
 */
export const LINKSET_CONTENT_TYPE =
	'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

export function buildApiCatalog(): unknown {
	return {
		linkset: [
			{
				anchor: absolute("/.well-known/api-catalog"),
				item: [
					{ href: absolute("/api/v1"), title: "EleenAI HTTP API" },
					{ href: absolute("/mcp"), title: "EleenAI MCP Server" },
				],
			},
			{
				anchor: absolute("/api/v1"),
				"service-desc": [
					{
						href: absolute("/api/v1/openapi.json"),
						type: "application/json",
						title: "OpenAPI 3.1 description",
					},
				],
				"service-doc": [
					{
						href: absolute("/docs"),
						type: "text/html",
						title: "EleenAI API documentation",
					},
					{
						href: absolute("/docs.md"),
						type: "text/markdown",
						title: "EleenAI API documentation (markdown)",
					},
				],
				"service-meta": [
					{
						href: absolute("/.well-known/oauth-protected-resource"),
						type: "application/json",
						title: "Protected resource metadata (RFC 9728)",
					},
					{
						href: absolute("/.well-known/oauth-authorization-server"),
						type: "application/json",
						title: "Authorization server metadata and agent_auth (RFC 8414)",
					},
				],
				status: [
					{
						href: absolute("/api/v1/health"),
						type: "application/json",
						title: "Health check",
					},
				],
			},
			{
				anchor: absolute("/mcp"),
				"service-desc": [
					{
						href: absolute("/.well-known/mcp.json"),
						type: "application/json",
						title: "MCP server card",
					},
				],
				"service-doc": [
					{ href: absolute("/docs"), type: "text/html", title: "EleenAI API documentation" },
				],
				"service-meta": [
					{
						href: absolute("/.well-known/oauth-protected-resource/mcp"),
						type: "application/json",
						title: "MCP protected resource metadata (RFC 9728)",
					},
					{
						href: absolute("/.well-known/oauth-authorization-server"),
						type: "application/json",
						title: "Authorization server metadata and agent_auth (RFC 8414)",
					},
				],
				status: [
					{ href: absolute("/api/v1/health"), type: "application/json", title: "Health check" },
				],
			},
		],
	};
}

// ─── Item 7: /.well-known/oauth-protected-resource ───────────────────────────

/**
 * RFC 9728 §3.1 requires a path-suffixed metadata document for a resource
 * that has a path component. An MCP client resolving `https://eleenai.xyz/mcp`
 * fetches `/.well-known/oauth-protected-resource/mcp`, so serving only the
 * root document leaves MCP's OAuth discovery broken.
 */
export function buildProtectedResource(env: Env, variant: "root" | "mcp"): unknown {
	const isMcp = variant === "mcp";

	return {
		resource: isMcp ? absolute("/mcp") : ORIGIN,
		authorization_servers: [clerkIssuer(env)],
		bearer_methods_supported: ["header"],
		scopes_supported: ["chat", "image", "vision", "search"],
		resource_name: isMcp ? "EleenAI MCP Server" : "EleenAI API",
		resource_documentation: absolute("/auth.md"),
		resource_policy_uri: absolute("/docs"),
		tls_client_certificate_bound_access_tokens: false,
		dpop_bound_access_tokens_required: false,
	};
}

// ─── /.well-known/oauth-authorization-server ─────────────────────────────────

/**
 * Authorization server metadata, carrying the `agent_auth` block.
 *
 * A deliberate and documented deviation, so it is not "fixed" by accident:
 * RFC 8414 §3.3 requires the `issuer` in this document to be identical to the
 * URL prefix it was fetched from. This document is served at eleenai.xyz but
 * declares Clerk's issuer, because Clerk mints the tokens. That mismatch is
 * exactly why `/.well-known/openid-configuration` below is a 307 rather than a
 * synthetic document.
 *
 * The difference is that `agent_auth` has nowhere else to live. It describes
 * how agents authenticate to *EleenAI*, and Clerk's own metadata document —
 * the only RFC-conformant place to look — cannot carry a block about a resource
 * server it does not know about. Serving it here with an honest, correctly
 * resolving `issuer` is the tradeoff that makes the block discoverable at all.
 * Clients that only need OAuth endpoints should follow `authorization_servers`
 * in the RFC 9728 protected-resource document and fetch Clerk's copy directly.
 *
 * https://www.rfc-editor.org/rfc/rfc8414 · https://github.com/workos/auth.md
 */
export function buildAuthorizationServer(env: Env): unknown {
	const issuer = clerkIssuer(env);

	// Mirrored from Clerk's own document rather than invented, so a client that
	// reads this copy and one that follows `authorization_servers` to Clerk's
	// copy end up at the same endpoints. Verified against the live document;
	// re-check after a Clerk instance migration.
	return {
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/oauth/token`,
		revocation_endpoint: `${issuer}/oauth/token/revoke`,
		jwks_uri: `${issuer}/.well-known/jwks.json`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
		code_challenge_methods_supported: ["S256"],
		// The resource scopes EleenAI itself enforces. Clerk's document lists the
		// OIDC scopes it issues; these are the ones that gate this API, and they
		// match `scopes_supported` in the RFC 9728 protected-resource document.
		scopes_supported: ["chat", "image", "vision", "search"],

		/**
		 * Only `anonymous` is advertised, and it is not a placeholder — it maps
		 * to the `/guest` routes that serve unauthenticated agents today.
		 *
		 * `identity_assertion` and `service_auth` are deliberately absent. Both
		 * require a registration endpoint, a claim ceremony and a JWT-bearer
		 * exchange that EleenAI has not built; advertising them would point
		 * agents at URLs that 404. A capability listed here has to be one a
		 * client can actually exercise.
		 */
		agent_auth: {
			skill: absolute("/auth.md"),
			identity_types_supported: ["anonymous"],
			anonymous: {
				credential_types_supported: ["none"],
				claim_uri: absolute("/auth.md"),
			},
		},
	};
}

/**
 * The `WWW-Authenticate` challenge for a 401.
 *
 * RFC 6750 §3 is specific: a challenge carrying no `error` parameter means no
 * credentials were presented. Emitting `error="invalid_token"` when the client
 * sent nothing at all misleads OAuth clients into believing their refresh
 * failed, so the parameter is conditional on a token actually being supplied.
 */
export function bearerChallenge(request: Request, variant: "root" | "mcp" = "root"): string {
	const metadataUrl = absolute(
		variant === "mcp"
			? "/.well-known/oauth-protected-resource/mcp"
			: "/.well-known/oauth-protected-resource",
	);

	const presentedToken = /^Bearer\s+\S/i.test(request.headers.get("authorization") || "");

	return presentedToken
		? `Bearer resource_metadata="${metadataUrl}", error="invalid_token", ` +
				`error_description="The access token is expired, malformed or otherwise invalid"`
		: `Bearer resource_metadata="${metadataUrl}"`;
}

// ─── Item 6: /.well-known/openid-configuration ───────────────────────────────

/**
 * Redirect rather than serve.
 *
 * OpenID Connect Discovery §4.3 requires the `issuer` in the document to be
 * identical to the URL prefix it was fetched from. A document served at
 * eleenai.xyz would therefore have to claim `"issuer": "https://eleenai.xyz"`
 * — but EleenAI is not the OP, Clerk is, and Clerk-minted tokens carry Clerk's
 * issuer. Publishing a synthetic document with a mismatched issuer breaks
 * every conformant validator.
 *
 * Redirecting to the real document is a mild convention violation but keeps
 * the metadata honest. The standards-sanctioned indirection is RFC 9728's
 * `authorization_servers` array, which item 7 publishes.
 */
export function openidConfigurationRedirect(env: Env): Response {
	return new Response(null, {
		status: 307,
		headers: {
			location: `${clerkIssuer(env)}/.well-known/openid-configuration`,
			"cache-control": "no-store",
			link: `<${absolute("/.well-known/oauth-protected-resource")}>; rel="oauth-protected-resource"`,
		},
	});
}
