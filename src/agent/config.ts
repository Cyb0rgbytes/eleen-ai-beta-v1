/**
 * Shared constants and derivations for the agent-readiness surfaces.
 *
 * Everything that names the site lives here, so re-pointing at a staging
 * origin is a one-line change rather than a grep across a dozen files.
 */
import { Env } from "../types";

/** Canonical public origin. No trailing slash. */
export const ORIGIN = "https://eleenai.xyz";

/**
 * Last modification date advertised in the sitemap, as YYYY-MM-DD.
 *
 * Deliberately a build constant. Deriving this from `new Date()` would emit a
 * different value on every request, which crawlers read as "this document
 * changes constantly" and learn to distrust. Bump it by hand when the public
 * surface actually changes.
 */
export const SITE_LASTMOD = "2026-07-30";

/** Version reported by /api/v1/health, the OpenAPI document and the MCP card. */
export const API_VERSION = "1.0.0";

/** Resolve a site-relative path to an absolute URL on the canonical origin. */
export function absolute(path: string): string {
	return path.startsWith("/") ? ORIGIN + path : `${ORIGIN}/${path}`;
}

/**
 * Derive the Clerk issuer origin from the publishable key.
 *
 * A Clerk publishable key is `pk_(test|live)_` followed by the base64 of the
 * instance's frontend API host with a trailing `$`. Decoding it means the
 * OAuth/OIDC metadata documents track the Clerk instance automatically: when
 * the user migrates from the dev instance to production, they change the key
 * in wrangler.jsonc and every published document follows. No code change.
 */
export function clerkIssuer(env: Env): string {
	const key = env.CLERK_PUBLISHABLE_KEY || "";
	const encoded = key.replace(/^pk_(test|live)_/, "");

	try {
		const host = atob(encoded).replace(/\$+$/, "").trim();
		// Guard against a truncated or placeholder key decoding to garbage.
		if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
			return `https://${host}`;
		}
	} catch {
		// atob throws on non-base64 input; fall through to the default below.
	}

	// Last resort so metadata documents stay well-formed even with a bad key.
	return "https://clerk.eleenai.xyz";
}
