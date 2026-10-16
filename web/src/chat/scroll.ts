/**
 * Keep the conversation pinned to its newest line, unless the reader has
 * scrolled up to re-read something. Streaming calls follow() on every
 * paint; without the threshold, scrolling up would be yanked back down
 * mid-sentence.
 */
export const STICK_THRESHOLD_PX = 80;

export function distanceFromBottom(el: HTMLElement): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function isNearBottom(el: HTMLElement): boolean {
	return distanceFromBottom(el) <= STICK_THRESHOLD_PX;
}

/** Scroll to the end if the reader is near it, or always when forced. */
export function follow(el: HTMLElement, { force = false } = {}): void {
	if (!force && !isNearBottom(el)) return;
	el.scrollTop = el.scrollHeight;
}
