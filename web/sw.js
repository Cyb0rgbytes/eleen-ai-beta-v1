/*
 * EleenAI's service worker (M5.5). Built, not copied: vite.config.mts reads
 * this file, fills in VERSION and PRECACHE from the build's own output, and
 * writes it to dist/sw.js. Registered by web/src/pwa/register.ts.
 *
 * What it does, and nothing more:
 * - Precaches the hashed build output: every /assets/* script and stylesheet,
 *   and the primary /fonts/* faces, plus /offline (the fallback page).
 *   Hashed URLs never change content, so cache-first is always correct for
 *   them, and an open tab keeps finding the lazy chunks of the build it was
 *   loaded from even after a deploy removed them from the server.
 * - Navigations are network-first. Only when the network fails does it
 *   answer with the offline page. Pages are never cached.
 * - Any other /assets/* or /fonts/* file is cached the first time it is
 *   fetched.
 *
 * It never touches: non-GET requests, anything cross-origin (Clerk,
 * unpkg, assets.eleenai.xyz, analytics), /api/*, /mcp, /.well-known/*,
 * /cdn-cgi/*, or any other same-origin path. For those it does not call
 * respondWith, so the browser handles them exactly as without a worker.
 *
 * Updates: one cache per build ("eleenai-<VERSION>"); activate deletes the
 * others. A new worker installs in the background and then WAITS: it does
 * not skipWaiting on its own, so an open chat keeps the worker (and the
 * build) it started with. It takes over on the next load after every tab
 * of the old one has closed, or at once when the reader accepts the
 * "update ready" prompt, which posts SKIP_WAITING and reloads that tab.
 */

const VERSION = "__SW_VERSION__";
const PRECACHE = /** @type {string[]} */ (JSON.parse("__SW_PRECACHE__"));
const OFFLINE_URL = "/offline";
const CACHE = `eleenai-${VERSION}`;
const PREFIX = "eleenai-";

/** Paths the worker must never answer, even if a rule below would match. */
const NEVER = [/^\/api\//, /^\/mcp(\/|$)/, /^\/\.well-known\//, /^\/cdn-cgi\//];

/** Hashed build output: immutable, so cache-first. */
const IMMUTABLE = /^\/(assets|fonts)\//;

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await Promise.all(
				[...PRECACHE, OFFLINE_URL].map(async (url) => {
					// A hashed file an older build already holds is the same bytes.
					const known = IMMUTABLE.test(url) ? await caches.match(url) : undefined;
					if (known) return cache.put(url, known);
					const response = await fetch(url, { cache: "no-cache" });
					if (!response.ok || response.redirected) throw new Error(`Precache failed for ${url}: ${response.status}`);
					return cache.put(url, response);
				}),
			);
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			for (const name of await caches.keys()) {
				if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
			}
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (NEVER.some((pattern) => pattern.test(url.pathname))) return;

	if (request.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					return await fetch(request);
				} catch (error) {
					const offline = await caches.match(OFFLINE_URL);
					if (offline) return offline;
					throw error;
				}
			})(),
		);
		return;
	}

	if (IMMUTABLE.test(url.pathname)) {
		event.respondWith(
			(async () => {
				const cached = await caches.match(request);
				if (cached) return cached;
				const response = await fetch(request);
				if (response.ok && response.type === "basic") {
					const copy = response.clone();
					event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
				}
				return response;
			})(),
		);
	}
	// Everything else: no respondWith, so the browser fetches it as usual.
});
