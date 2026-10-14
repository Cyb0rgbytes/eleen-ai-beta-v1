/**
 * Item 1 — /sitemap.xml
 *
 * public/robots.txt already advertises this URL, so until now that reference
 * dangled and 404'd.
 *
 * https://www.sitemaps.org/protocol.html
 */
import { ORIGIN, SITE_LASTMOD } from "./config";

interface SitemapEntry {
	path: string;
	changefreq: "daily" | "weekly" | "monthly" | "yearly";
	priority: string;
}

/** Canonical, indexable URLs. Metadata documents under /.well-known are
 *  discovered via Link headers and the API catalog, not the sitemap. */
const ENTRIES: SitemapEntry[] = [
	{ path: "/", changefreq: "weekly", priority: "1.0" },
	{ path: "/docs", changefreq: "monthly", priority: "0.8" },
	{ path: "/auth.md", changefreq: "monthly", priority: "0.3" },
];

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function buildSitemap(): string {
	const urls = ENTRIES.map(
		(entry) =>
			`  <url>\n` +
			`    <loc>${escapeXml(ORIGIN + entry.path)}</loc>\n` +
			`    <lastmod>${SITE_LASTMOD}</lastmod>\n` +
			`    <changefreq>${entry.changefreq}</changefreq>\n` +
			`    <priority>${entry.priority}</priority>\n` +
			`  </url>`,
	).join("\n");

	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
		`${urls}\n` +
		`</urlset>\n`
	);
}

/** Built once at module scope — the content is static between deploys. */
export const SITEMAP_XML = buildSitemap();
