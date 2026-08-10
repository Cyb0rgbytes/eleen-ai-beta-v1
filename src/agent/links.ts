/**
 * Item 2 — RFC 8288 Link response headers for agent discovery.
 *
 * https://www.rfc-editor.org/rfc/rfc8288
 * https://www.rfc-editor.org/rfc/rfc9727#section-3
 *
 * A note on conformance: `api-catalog` (RFC 9727), `service-desc` and
 * `service-doc` (RFC 8631), and `alternate` are IANA-registered relation
 * types. `oauth-protected-resource`, `oauth-authorization-server` and
 * `mcp-server` are NOT — RFC 9728 and RFC 8414 each define a well-known URI
 * (and, for 9728, a WWW-Authenticate parameter), not a link relation. They are
 * included because MCP and agent clients look for them in practice; the
 * strictly-correct alternative is an extension relation URI that no client
 * currently recognizes.
 */

interface LinkEntry {
	href: string;
	rel: string;
	type?: string;
	title?: string;
}

const ENTRIES: LinkEntry[] = [
	{
		href: "/.well-known/api-catalog",
		rel: "api-catalog",
		type: "application/linkset+json",
		title: "API catalog",
	},
	{
		href: "/api/v1/openapi.json",
		rel: "service-desc",
		type: "application/json",
		title: "OpenAPI 3.1 description",
	},
	{ href: "/docs", rel: "service-doc", type: "text/html", title: "API documentation" },
	{
		href: "/.well-known/oauth-protected-resource",
		rel: "oauth-protected-resource",
		type: "application/json",
		title: "Protected resource metadata",
	},
	{
		href: "/.well-known/oauth-authorization-server",
		rel: "oauth-authorization-server",
		type: "application/json",
		title: "Authorization server metadata and agent_auth",
	},
	{ href: "/mcp", rel: "mcp-server", title: "MCP endpoint" },
];

function serialize(entries: LinkEntry[]): string {
	return entries
		.map((entry) => {
			let value = `<${entry.href}>; rel="${entry.rel}"`;
			if (entry.type) value += `; type="${entry.type}"`;
			if (entry.title) value += `; title="${entry.title}"`;
			return value;
		})
		.join(", ");
}

/** Link header for `/`, whose markdown rendition lives at /index.md. */
export const LINK_HEADER_HOME = serialize([
	...ENTRIES,
	{
		href: "/index.md",
		rel: "alternate",
		type: "text/markdown",
		title: "This page as markdown",
	},
]);

/** Link header for `/docs`, whose markdown rendition lives at /docs.md. */
export const LINK_HEADER_DOCS = serialize([
	...ENTRIES,
	{
		href: "/docs.md",
		rel: "alternate",
		type: "text/markdown",
		title: "This page as markdown",
	},
]);
