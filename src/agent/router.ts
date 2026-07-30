/**
 * Dispatcher for the agent-readiness surfaces.
 *
 * Returns `null` for anything it does not own, which lets src/index.ts fall
 * through to its existing routing chain untouched. This is deliberately the
 * only integration point: one call, one null check.
 *
 * It must be invoked BEFORE the static-asset delegation in src/index.ts.
 * Two of these routes (/api/v1/health, /api/v1/openapi.json) start with /api/
 * and would otherwise reach the Clerk auth gate and 401; the rest would be
 * handed to env.ASSETS.fetch() and 404.
 */
import { Env } from "../types";
import { API_VERSION, absolute } from "./config";
import { AgentHandlers } from "./deps";
import {
	CACHE_NEGOTIATED,
	body,
	estimateTokens,
	isRead,
	json,
	markdown,
	methodNotAllowed,
} from "./http";
import { SITEMAP_XML } from "./sitemap";
import { LINK_HEADER_DOCS, LINK_HEADER_HOME } from "./links";
import { prefersMarkdown } from "./negotiate";
import { DOCS_HTML } from "./docs";
import { HEALTH_DOCUMENT, OPENAPI_JSON } from "./openapi";
import { MCP_SERVER_CARD, handleMcp } from "./mcp";
import {
	LINKSET_CONTENT_TYPE,
	buildApiCatalog,
	buildProtectedResource,
	openidConfigurationRedirect,
} from "./wellknown";
import AUTH_MD from "./content/auth.md";
import HOME_MD from "./content/home.md";
import DOCS_MD from "./content/docs.md";

/** Computed once, not per request — these are compile-time constants. */
const HOME_MD_TOKENS = String(estimateTokens(HOME_MD));
const DOCS_MD_TOKENS = String(estimateTokens(DOCS_MD));

const READ_ONLY = "GET, HEAD";

export async function handleAgentRoutes(
	request: Request,
	url: URL,
	env: Env,
	ctx: ExecutionContext,
	handlers: AgentHandlers,
): Promise<Response | null> {
	const path = url.pathname;

	// ── Items 2 + 4: the negotiated homepage ─────────────────────────────
	// Reached only because assets.run_worker_first routes "/" here. The HTML
	// branch delegates straight back to the asset binding, so the browser
	// experience is byte-identical to before; we only add headers.
	if (path === "/" || path === "/index.html") {
		if (!isRead(request)) return null; // not ours; let the chain 404 it

		if (prefersMarkdown(request.headers.get("accept"))) {
			return markdown(request, HOME_MD, {
				link: LINK_HEADER_HOME,
				"cache-control": CACHE_NEGOTIATED,
				"x-markdown-tokens": HOME_MD_TOKENS,
			});
		}

		const asset = await env.ASSETS.fetch(request);
		// Header objects on a fetched Response are immutable; clone to decorate.
		const decorated = new Response(asset.body, asset);
		decorated.headers.set("link", LINK_HEADER_HOME);
		decorated.headers.append("vary", "Accept");
		// Two variants behind one URL, and Cloudflare's cache ignores Vary.
		decorated.headers.set("cache-control", CACHE_NEGOTIATED);
		return decorated;
	}

	// ── Item 1: sitemap ──────────────────────────────────────────────────
	if (path === "/sitemap.xml") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return body(request, SITEMAP_XML, "application/xml; charset=utf-8");
	}

	// ── Item 8: auth.md ──────────────────────────────────────────────────
	if (path === "/auth.md") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return markdown(request, AUTH_MD);
	}

	// ── Stable markdown renditions ───────────────────────────────────────
	// Distinct URLs, so these are safely cacheable and carry no Vary.
	if (path === "/index.md") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return markdown(request, HOME_MD, {
			vary: "",
			"x-markdown-tokens": HOME_MD_TOKENS,
			link: LINK_HEADER_HOME,
		});
	}

	if (path === "/docs.md") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return markdown(request, DOCS_MD, {
			vary: "",
			"x-markdown-tokens": DOCS_MD_TOKENS,
			link: LINK_HEADER_DOCS,
		});
	}

	// ── Documentation (negotiable) ───────────────────────────────────────
	if (path === "/docs" || path === "/docs/") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);

		if (prefersMarkdown(request.headers.get("accept"))) {
			return markdown(request, DOCS_MD, {
				link: LINK_HEADER_DOCS,
				"cache-control": CACHE_NEGOTIATED,
				"x-markdown-tokens": DOCS_MD_TOKENS,
			});
		}

		return body(request, DOCS_HTML, "text/html; charset=utf-8", {
			link: LINK_HEADER_DOCS,
			vary: "Accept",
			"cache-control": CACHE_NEGOTIATED,
		});
	}

	// ── API description and health ───────────────────────────────────────
	// These live under /api/ and must be claimed here, above the auth gate.

	// The API catalog uses /api/v1 as a linkset anchor. An anchor is an
	// identifier and need not be dereferenceable, but leaving it to fall
	// through to the auth gate made it 500 — which reads as a broken service
	// to anything that probes the catalog. A small index is cheaper than an
	// explanation.
	if (path === "/api/v1" || path === "/api/v1/") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return json(request, {
			name: "EleenAI HTTP API",
			version: API_VERSION,
			documentation: absolute("/docs"),
			description: absolute("/api/v1/openapi.json"),
			health: absolute("/api/v1/health"),
			authentication: absolute("/.well-known/oauth-protected-resource"),
		});
	}

	if (path === "/api/v1/openapi.json") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return body(request, OPENAPI_JSON, "application/json; charset=utf-8");
	}

	if (path === "/api/v1/health") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return json(request, HEALTH_DOCUMENT, "application/json; charset=utf-8", {
			"cache-control": "no-store",
		});
	}

	// ── Item 5: API catalog ──────────────────────────────────────────────
	if (path === "/.well-known/api-catalog") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return json(request, buildApiCatalog(), LINKSET_CONTENT_TYPE);
	}

	// ── Item 7: protected resource metadata ──────────────────────────────
	if (path === "/.well-known/oauth-protected-resource") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return json(request, buildProtectedResource(env, "root"));
	}

	if (path === "/.well-known/oauth-protected-resource/mcp") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return json(request, buildProtectedResource(env, "mcp"));
	}

	// ── Item 9: MCP endpoint and server card ─────────────────────────────
	if (path === "/mcp") {
		return handleMcp(request, env, ctx, handlers);
	}

	// SEP-2127 path, and the superseded SEP-1649 path. Same body, so either
	// generation of client can discover the server.
	if (path === "/.well-known/mcp.json" || path === "/.well-known/mcp/server-card.json") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return json(request, MCP_SERVER_CARD);
	}

	// ── Item 6: OIDC discovery (redirected — see wellknown.ts) ───────────
	if (path === "/.well-known/openid-configuration") {
		if (!isRead(request)) return methodNotAllowed(READ_ONLY);
		return openidConfigurationRedirect(env);
	}

	return null;
}
