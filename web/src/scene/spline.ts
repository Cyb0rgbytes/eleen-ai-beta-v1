/**
 * The Spline scene: fade-in, the one error it is allowed to throw, and wheel
 * forwarding.
 *
 * The viewer itself is @splinetool/viewer 1.12.88 from unpkg, loaded by a
 * <script type="module"> in index.html. It is the only third-party script
 * left besides Clerk: the package declares no licence, so self-hosting it
 * is not clearly permitted. It is never filtered, tinted or blended
 * (DESIGN.md section 2.1).
 */

const FADE_FALLBACK_MS = 3000;

export function initScene(): void {
	const bg = document.getElementById("spline-bg");
	const loader = document.getElementById("spline-loader");
	const viewer = bg?.querySelector("spline-viewer");

	// The viewer's render loop throws "Cannot read properties of undefined
	// (reading 'position')" about 240 times a second, an internal fault in
	// its onFrame unrelated to this page (measured: no FPS cost). Swallow
	// exactly that, from exactly that script, and nothing else.
	window.addEventListener("error", (event) => {
		const fromViewer = typeof event.filename === "string" && event.filename.includes("spline-viewer");
		const isFrameFault = typeof event.message === "string" && event.message.includes("reading 'position'");
		if (fromViewer && isFrameFault) event.preventDefault();
	});

	if (bg && viewer) {
		const loaded = () => {
			bg.classList.add("loaded");
			loader?.classList.add("hidden");
		};
		viewer.addEventListener("load", loaded, { once: true });
		setTimeout(loaded, FADE_FALLBACK_MS);
	}
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
			if (event.target instanceof Element && event.target.closest("textarea, pre, .md-table, .message-input")) return;
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
