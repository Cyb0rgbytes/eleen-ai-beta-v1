/**
 * The 3D scene: a still poster first, the live Spline viewer when the
 * device can afford it (DESIGN.md section 8).
 *
 * The poster (/scene-poster.webp, 7 KB, made by scripts/capture-poster.mjs)
 * is in the HTML, so the page has its backdrop on first paint. The viewer
 * runtime is 2.3 MB of JavaScript; it is only fetched when none of the skip
 * conditions hold, and the poster crossfades to the live scene once it has
 * rendered.
 *
 * The viewer is @splinetool/viewer 1.12.88 from unpkg: the package declares
 * no licence, so it is not self-hosted. It is never filtered, tinted or
 * blended (DESIGN.md section 2.1).
 */

const VIEWER_SRC = "https://unpkg.com/@splinetool/viewer@1.12.88/build/spline-viewer.js";
const SCENE_URL = "https://assets.eleenai.xyz/r_4_x_bot.splinecode";
const FADE_FALLBACK_MS = 3000;

export type SceneMode = "live" | "poster";

interface NetworkInformationLike {
	saveData?: boolean;
	effectiveType?: string;
}

/** Why the live scene should be skipped, or null to load it. */
export function skipReason(): string | null {
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return "reduced-motion";
	const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
	if (connection?.saveData) return "save-data";
	if (connection?.effectiveType && /(^|-)2g$/.test(connection.effectiveType)) return "slow-network";
	if (typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency < 4) return "low-cores";
	if (window.matchMedia("(pointer: coarse)").matches) return "coarse-pointer";
	return null;
}

/**
 * Trusted Types: assigning a script's src is a sink. The page's only one
 * goes through this policy, which accepts exactly the pinned viewer URL and
 * nothing else, so our own code would pass `require-trusted-types-for`.
 */
interface TrustedTypesLike {
	createPolicy(name: string, rules: { createScriptURL(url: string): string }): { createScriptURL(url: string): unknown };
}

const viewerPolicy = (window as Window & { trustedTypes?: TrustedTypesLike }).trustedTypes?.createPolicy("eleenai-scene", {
	createScriptURL(url) {
		if (url !== VIEWER_SRC) throw new TypeError("Only the pinned Spline viewer may be loaded.");
		return url;
	},
});

function loadViewer(): void {
	const prefetch = document.createElement("link");
	prefetch.rel = "prefetch";
	prefetch.as = "fetch";
	prefetch.crossOrigin = "anonymous";
	prefetch.href = SCENE_URL;
	document.head.append(prefetch);

	const script = document.createElement("script");
	script.type = "module";
	script.async = true;
	// A TrustedScriptURL where Trusted Types exist, the plain string elsewhere.
	script.src = (viewerPolicy?.createScriptURL(VIEWER_SRC) ?? VIEWER_SRC) as string;
	document.head.append(script);
}

export function initScene(): SceneMode {
	const bg = document.getElementById("spline-bg");
	const loader = document.getElementById("spline-loader");
	const viewer = bg?.querySelector("spline-viewer");

	const reason = skipReason();
	if (reason || !bg || !viewer) {
		if (bg) {
			bg.dataset.mode = "poster";
			if (reason) bg.dataset.skip = reason;
		}
		loader?.classList.add("hidden");
		viewer?.remove();
		return "poster";
	}

	bg.dataset.mode = "live";

	// The viewer's render loop throws "Cannot read properties of undefined
	// (reading 'position')" about 240 times a second, an internal fault in
	// its onFrame unrelated to this page (measured: no FPS cost). Swallow
	// exactly that, from exactly that script, and nothing else.
	window.addEventListener("error", (event) => {
		const fromViewer = typeof event.filename === "string" && event.filename.includes("spline-viewer");
		const isFrameFault = typeof event.message === "string" && event.message.includes("reading 'position'");
		if (fromViewer && isFrameFault) event.preventDefault();
	});

	const loaded = () => {
		bg.classList.add("loaded");
		loader?.classList.add("hidden");
	};
	viewer.addEventListener("load", loaded, { once: true });
	loadViewer();
	// The viewer's load event is not reliable across versions; the poster
	// stays underneath, so an early crossfade only reveals the same scene.
	setTimeout(loaded, FADE_FALLBACK_MS);
	return "live";
}

/**
 * The message column is click-through so the scene keeps seeing the cursor
 * across the middle of the screen (DESIGN.md section 5). The wheel needs a
 * real target, so it is caught on the window and applied to the scroller
 * whenever the pointer is over it. Elements that scroll themselves keep
 * their own wheel.
 */
export function forwardWheel(scroller: HTMLElement): void {
	window.addEventListener(
		"wheel",
		(event) => {
			if (event.target instanceof Element && event.target.closest("textarea, pre, .md-table, .message-input, .reasoning-text")) return;
			const box = scroller.getBoundingClientRect();
			const over =
				event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
			if (!over || scroller.scrollHeight <= scroller.clientHeight) return;
			scroller.scrollTop += event.deltaY;
			event.preventDefault();
		},
		{ passive: false },
	);
}
