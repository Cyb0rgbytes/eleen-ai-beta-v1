/**
 * Scripted motion, on the same terms as motion.css (DESIGN.md section 8):
 * transform and opacity only, --ease, 160 to 320 ms, nothing under
 * prefers-reduced-motion. Uses Motion's WAAPI build, so the browser runs
 * the animation off the main thread.
 *
 * The send-button spring the classic page used is gone: every motion on
 * the page now shares one curve.
 */
import { animate } from "motion/mini";

export const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
export const DURATION = { state: 0.16, reveal: 0.24, panel: 0.32 } as const;

const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

export function prefersReducedMotion(): boolean {
	return reducedQuery.matches;
}

/** A short press: scale down and back, for buttons that act immediately. */
export function pressFeedback(element: HTMLElement): void {
	if (prefersReducedMotion()) return;
	const down = () => void animate(element, { transform: "scale(0.92)" }, { duration: DURATION.state, ease: EASE });
	const up = () => void animate(element, { transform: "scale(1)" }, { duration: DURATION.state, ease: EASE });
	element.addEventListener("pointerdown", down);
	element.addEventListener("pointerup", up);
	element.addEventListener("pointerleave", up);
	element.addEventListener("pointercancel", up);
}

/** Fade and rise into place, once. */
export function revealIn(element: Element, delaySeconds = 0): void {
	if (prefersReducedMotion()) return;
	void animate(
		element,
		{ opacity: [0, 1], transform: ["translateY(-12px)", "translateY(0)"] },
		{ duration: DURATION.reveal, ease: EASE, delay: delaySeconds },
	);
}
