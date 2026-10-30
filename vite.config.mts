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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * The service worker (M5.5): web/sw.js, with its precache list and version
 * filled in from this build's output, written to dist/sw.js. Precached: every
 * hashed script and stylesheet under assets/, and the WOFF2 faces the page
 * uses first (Inter Latin, Noto Sans Arabic's Arabic subset, JetBrains Mono).
 * Other font subsets are cached by the worker when first used.
 */
const PRECACHE_FONTS = /^fonts\/(inter-latin(-ext)?-wght|noto-sans-arabic-arabic-\d+|jetbrains-mono-latin-400)-normal-[\w-]+\.woff2$/;

function serviceWorker(): Plugin {
	const template = fileURLToPath(new URL("./web/sw.js", import.meta.url));
	return {
		name: "eleenai-service-worker",
		apply: "build",
		// writeBundle, not generateBundle: by now the HTML plugin has dropped
		// the privacy page's empty script chunk, so every listed file exists.
		writeBundle(options, bundle) {
			const dir = options.dir ?? "dist";
			const files = Object.keys(bundle)
				.filter((name) => /^assets\/[\w.-]+\.(js|css)$/.test(name) || PRECACHE_FONTS.test(name))
				.filter((name) => existsSync(join(dir, name)))
				.sort()
				.map((name) => `/${name}`);
			const source = readFileSync(template, "utf8");
			const version = createHash("sha256").update(source).update(files.join("\n")).digest("hex").slice(0, 12);
			writeFileSync(
				join(dir, "sw.js"),
				source.replace("__SW_VERSION__", version).replace('"__SW_PRECACHE__"', JSON.stringify(JSON.stringify(files))),
			);
		},
	};
}

export default defineConfig({
	root: "web",
	plugins: [serviceWorker()],
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
				// EleenAI Studio: its own page, sharing the app's sign-in.
				studio: fileURLToPath(new URL("./web/studio.html", import.meta.url)),
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
