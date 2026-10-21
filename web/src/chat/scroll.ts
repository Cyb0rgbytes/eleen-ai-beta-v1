/**
 * Keep the conversation pinned to its newest line, unless the reader has
 * scrolled up to re-read something. Streaming calls follow() on every
 * paint.
 *
 * Distance alone cannot tell a reader from the end: a trackpad scrolls a
 * few pixels at a time, never leaves an 80px window, and was pulled back on
 * every paint. So any scroll up detaches the follow, and it resumes when the
 * reader scrolls back down to the end, or a send forces it.
 */
export const STICK_THRESHOLD_PX = 80;

const detached = new WeakSet<HTMLElement>();

export function distanceFromBottom(el: HTMLElement): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function isNearBottom(el: HTMLElement): boolean {
	return distanceFromBottom(el) <= STICK_THRESHOLD_PX;
}

/** Watch the reader's own scrolling, so follow() knows when to hold off. */
export function watchReader(el: HTMLElement): void {
	let last = el.scrollTop;
	el.addEventListener(
		"scroll",
		() => {
			const top = el.scrollTop;
			// Content removed under a reader at the end clamps scrollTop down
			// without them moving; they are still at the end, so that is no
			// scroll up.
			if (top < last && distanceFromBottom(el) > 1) detached.add(el);
			else if (top > last && isNearBottom(el)) detached.delete(el);
			last = top;
		},
		{ passive: true },
	);
}

/** Scroll to the end if the reader is following it, or always when forced. */
export function follow(el: HTMLElement, { force = false } = {}): void {
	if (force) detached.delete(el);
	else if (detached.has(el) || !isNearBottom(el)) return;
	el.scrollTop = el.scrollHeight;
}
