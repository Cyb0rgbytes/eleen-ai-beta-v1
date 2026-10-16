/**
 * "Jump to latest" (DESIGN.md section 7): a pill above the composer that
 * appears when the reader has scrolled more than 160px up while a reply is
 * streaming, and takes them back to the end.
 *
 * It listens to the scroller's own scroll event (passive, read only; the
 * window is never listened to) and to the busy state.
 */
import { t } from "../i18n";
import { icon } from "../ui/icons";
import { prefersReducedMotion } from "../ui/motion";
import { distanceFromBottom, follow } from "./scroll";

export const JUMP_THRESHOLD_PX = 160;

export interface JumpPill {
	setBusy(busy: boolean): void;
}

export function initJumpPill(scroller: HTMLElement, host: HTMLElement): JumpPill {
	const pill = document.createElement("button");
	pill.type = "button";
	pill.className = "jump-pill";
	pill.hidden = true;
	const label = document.createElement("span");
	label.textContent = t("jumpToLatest");
	pill.append(icon("arrow-down"), label);
	// A zero-height anchor just above the composer: the pill overlays the end
	// of the conversation without shifting anything when it appears.
	const anchor = document.createElement("div");
	anchor.className = "jump-anchor";
	anchor.append(pill);
	const composer = host.querySelector(".message-input");
	if (composer) composer.before(anchor);
	else host.append(anchor);

	let busy = false;
	let frame = 0;

	function update() {
		frame = 0;
		pill.hidden = !(busy && distanceFromBottom(scroller) > JUMP_THRESHOLD_PX);
	}

	function schedule() {
		if (!frame) frame = requestAnimationFrame(update);
	}

	scroller.addEventListener("scroll", schedule, { passive: true });
	// Content growing under a still reader also moves them away from the
	// end. Batched to one check per frame, so streaming stays cheap.
	new MutationObserver(schedule).observe(scroller, { childList: true, subtree: true, characterData: true });

	pill.addEventListener("click", () => {
		if (prefersReducedMotion()) follow(scroller, { force: true });
		else scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
		pill.hidden = true;
	});

	return {
		setBusy(next) {
			busy = next;
			schedule();
		},
	};
}
