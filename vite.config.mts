/**
 * Frontend build: web/ into dist/, which the Worker's assets binding serves.
 *
 * Entry is web/index.html. Its module script is web/src/main.ts, so every
 * page script is bundled, hashed and same-origin, which is what lets the CSP
 * drop 'unsafe-inline' and the CDN hosts. Fonts land under /fonts/ so the
 * font-src directive and cache rules can name one path.
 *
 * `wrangler dev` and `wrangler deploy` both run `npm run build` first, via
 * build.command in wrangler.jsonc, so dist/ is never committed.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	root: "web",
	publicDir: "public",
	build: {
		outDir: "../dist",
		emptyOutDir: true,
		target: "es2022",
		// Inline nothing: a data: URL would need img-src/font-src data:, and
		// every asset being a hashed file keeps the CSP simple.
		assetsInlineLimit: 0,
		rollupOptions: {
			// Two pages: the app, and the privacy policy (M4.6), which is a
			// stylesheet and text only, with no script.
			input: {
				// Named "index" so the app's chunks keep their index-* names.
				index: fileURLToPath(new URL("./web/index.html", import.meta.url)),
				privacy: fileURLToPath(new URL("./web/privacy.html", import.meta.url)),
			},
			output: {
				assetFileNames: (asset) =>
					/\.(woff2?|ttf|otf)$/.test(asset.names[0] ?? "")
						? "fonts/[name]-[hash][extname]"
						: "assets/[name]-[hash][extname]",
			},
		},
	},
	server: {
		// The Worker is the dev server. Vite's own server is not used.
		port: 5173,
	},
});
