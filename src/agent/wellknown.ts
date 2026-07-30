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
