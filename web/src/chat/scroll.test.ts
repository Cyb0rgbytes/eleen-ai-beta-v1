import { describe, expect, it } from "vitest";
import { follow, watchReader } from "./scroll";

/** A scroller with a 100px window; the DOM here does no layout. */
function scroller(contentHeight: number) {
	const el = document.createElement("div");
	let height = contentHeight;
	let top = 0;
	Object.defineProperty(el, "clientHeight", { get: () => 100 });
	Object.defineProperty(el, "scrollHeight", { get: () => height });
	Object.defineProperty(el, "scrollTop", {
		get: () => top,
		set: (value: number) => {
			top = Math.max(0, Math.min(value, height - 100));
		},
	});
	return {
		el,
		grow(by: number) {
			height += by;
		},
		/** The reader scrolls to `to`, as a wheel or trackpad would. */
		scrollTo(to: number) {
			el.scrollTop = to;
			el.dispatchEvent(new Event("scroll"));
		},
	};
}

describe("follow", () => {
	it("keeps a reader at the end pinned as the reply grows", () => {
		const s = scroller(1000);
		s.el.scrollTop = 900;
		watchReader(s.el);
		s.grow(50);
		follow(s.el);
		expect(s.el.scrollTop).toBe(950);
	});

	it("stops following after a trackpad-sized scroll up, well inside the 80px window", () => {
		const s = scroller(1000);
		s.el.scrollTop = 900;
		watchReader(s.el);
		s.scrollTo(896);
		s.grow(50);
		follow(s.el);
		expect(s.el.scrollTop).toBe(896);
	});

	it("resumes once the reader scrolls back down to the end", () => {
		const s = scroller(1000);
		s.el.scrollTop = 900;
		watchReader(s.el);
		s.scrollTo(700);
		s.grow(50);
		s.scrollTo(950);
		s.grow(50);
		follow(s.el);
		expect(s.el.scrollTop).toBe(1000);
	});

	it("resumes when a send forces it", () => {
		const s = scroller(1000);
		s.el.scrollTop = 900;
		watchReader(s.el);
		s.scrollTo(400);
		s.grow(50);
		follow(s.el, { force: true });
		expect(s.el.scrollTop).toBe(950);
		s.grow(50);
		follow(s.el);
		expect(s.el.scrollTop).toBe(1000);
	});

	it("does not treat content removed under a reader at the end as a scroll up", () => {
		const s = scroller(1000);
		s.el.scrollTop = 900;
		watchReader(s.el);
		s.grow(-200);
		s.scrollTo(s.el.scrollTop); // the browser clamps and fires scroll
		s.grow(50);
		follow(s.el);
		expect(s.el.scrollTop).toBe(750);
	});
});
