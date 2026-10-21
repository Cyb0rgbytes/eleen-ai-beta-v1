import { afterEach, describe, expect, it, vi } from "vitest";
import { POLICY_VERSION, type ConsentResponse } from "../../../src/shared/history";
import { needsConsent } from "./api";
import { createConsentDialog } from "./consent";
import { json, stubServer } from "./test-server";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

const unanswered: ConsentResponse = { consent: null, policyVersion: POLICY_VERSION };

function parts(dialog: HTMLDialogElement) {
	const buttons = [...dialog.querySelectorAll<HTMLButtonElement>(".privacy-actions button")];
	return {
		history: dialog.querySelector("#consent-history") as HTMLInputElement,
		memory: dialog.querySelector("#consent-memory") as HTMLInputElement,
		later: buttons[0] as HTMLButtonElement,
		save: buttons[1] as HTMLButtonElement,
		close: dialog.querySelector(".privacy-close") as HTMLButtonElement,
		error: dialog.querySelector(".privacy-error") as HTMLElement,
		changed: dialog.querySelector(".privacy-note") as HTMLElement,
		link: dialog.querySelector("a.privacy-link") as HTMLAnchorElement,
	};
}

describe("needsConsent", () => {
	it("asks when unanswered or answered for an older policy, and not otherwise", () => {
		expect(needsConsent(unanswered)).toBe(true);
		const answered = { history: true, memory: false, policyVersion: 1, updatedAt: 1 };
		expect(needsConsent({ consent: answered, policyVersion: 1 })).toBe(false);
		expect(needsConsent({ consent: answered, policyVersion: 2 })).toBe(true);
	});
});

describe("consent dialog", () => {
	it("opens at the defaults, history on and memory off, with the first switch focused", () => {
		stubServer({});
		const dialog = createConsentDialog();
		dialog.open(unanswered);
		const p = parts(dialog.element);
		expect(dialog.element.open).toBe(true);
		expect(p.history.checked).toBe(true);
		expect(p.memory.checked).toBe(false);
		expect(p.history.getAttribute("role")).toBe("switch");
		expect(dialog.element.querySelector(`label[for="consent-history"]`)?.textContent).toContain("Save my conversations");
		expect(document.activeElement).toBe(p.history);
		expect(p.changed.hidden).toBe(true);
		expect(p.link.getAttribute("href")).toBe("/privacy");
	});

	it("saves exactly the chosen switches with one PUT, then closes", async () => {
		const server = stubServer({
			"PUT /api/v1/consent": (call) => json(200, { consent: { ...call.body, policyVersion: 1, updatedAt: 2 }, policyVersion: 1 }),
		});
		const saved: ConsentResponse[] = [];
		const closed: boolean[] = [];
		const dialog = createConsentDialog({ onSaved: (r) => saved.push(r), onClose: (s) => closed.push(s) });
		dialog.open(unanswered);
		const p = parts(dialog.element);
		p.memory.click();
		p.save.click();
		await vi.waitFor(() => expect(dialog.element.open).toBe(false));
		expect(server.calls).toEqual([{ method: "PUT", path: "/api/v1/consent", body: { history: true, memory: true } }]);
		expect(saved[0]?.consent?.memory).toBe(true);
		expect(closed).toEqual([true]);
	});

	it("sends nothing when closed without choosing, by any route", () => {
		const server = stubServer({});
		const closed: boolean[] = [];
		const dialog = createConsentDialog({ onClose: (s) => closed.push(s) });
		for (const leave of ["later", "close", "escape"] as const) {
			dialog.open(unanswered);
			const p = parts(dialog.element);
			p.memory.click();
			if (leave === "later") p.later.click();
			else if (leave === "close") p.close.click();
			else dialog.close();
			expect(dialog.element.open).toBe(false);
		}
		expect(server.calls).toEqual([]);
		expect(closed).toEqual([false, false, false]);
	});

	it("keeps the dialog open with an inline error when the save fails", async () => {
		stubServer({ "PUT /api/v1/consent": () => json(503, { error: "down" }) });
		const dialog = createConsentDialog();
		dialog.open(unanswered);
		const p = parts(dialog.element);
		p.save.click();
		await vi.waitFor(() => expect(p.error.hidden).toBe(false));
		expect(p.error.textContent).toBe("Could not save your choices. Try again.");
		expect(dialog.element.open).toBe(true);
		expect(p.save.disabled).toBe(false);
	});

	it("asks again after a policy change, starting from the earlier answer", () => {
		stubServer({});
		const dialog = createConsentDialog();
		dialog.open({ consent: { history: false, memory: true, policyVersion: 0, updatedAt: 1 }, policyVersion: 1 });
		const p = parts(dialog.element);
		expect(p.history.checked).toBe(false);
		expect(p.memory.checked).toBe(true);
		expect(p.changed.hidden).toBe(false);
	});

	it("speaks Arabic and mirrors when the page does", () => {
		stubServer({});
		document.documentElement.lang = "ar";
		document.documentElement.dir = "rtl";
		try {
			const dialog = createConsentDialog();
			dialog.open(unanswered);
			expect(dialog.element.querySelector("#consent-title")?.textContent).toBe("محادثاتك والذاكرة");
			expect(parts(dialog.element).save.textContent).toBe("حفظ اختياراتي");
		} finally {
			document.documentElement.lang = "en";
			document.documentElement.dir = "ltr";
		}
	});
});
