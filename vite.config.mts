/**
 * Frontend build. An as-is port (M0.5): the page and its stylesheet go
 * through Vite and come out hashed and minified in dist/, which is what the
 * Worker's assets binding serves. chat.js and webmcp.js stay classic scripts
 * copied verbatim from web/public until M3.5 turns them into modules.
 *
 * `wrangler dev` and `wrangler deploy` both run `npm run build` first, via
 * build.command in wrangler.jsonc, so dist/ never has to be committed.
 */
import { defineConfig } from "vite";

export default defineConfig({
	root: "web",
	publicDir: "public",
	build: {
		outDir: "../dist",
		emptyOutDir: true,
		// The inline module script and the stylesheet are small; a single
		// chunk each is the right shape for one page.
		assetsInlineLimit: 0,
	},
	server: {
		// The Worker is the dev server. Vite's own server is not used.
		port: 5173,
	},
});
