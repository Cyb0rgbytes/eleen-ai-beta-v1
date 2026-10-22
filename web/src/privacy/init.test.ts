import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../auth/clerk";
import type { ConsentResponse } from "../../../src/shared/history";
import { initPrivacy } from "./init";
import { stubServer } from "./test-server";

let emit: (state: AuthState) => void;
const subscribe = (listener: (state: AuthState) => void) => {
	emit = listener;
	return () => {};
};

const signedIn: AuthState = { status: "signed-in", name: "Omar", imageUrl: null };
const guest: AuthState = { status: "guest" };

beforeEach(() => {
	stubServer({});
	const link = document.createElement("button");
	link.className = "model-keys-link model-privacy-link";
	link.hidden = true;
	document.body.append(link);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

const link = () => document.querySelector(".model-privacy-link") as HTMLButtonElement;
const consentDialog = () => document.querySelector<HTMLDialogElement>("dialog.consent-dialog");

describe("privacy wiring", () => {
	it("never asks a guest, and hides the panel link from them", async () => {
		const loadConsent = vi.fn(async (): Promise<ConsentResponse> => ({ consent: null, policyVersion: 1 }));
		const privacy = initPrivacy({ subscribe, loadConsent });
		emit(guest);
		await privacy.settled();
		expect(loadConsent).not.toHaveBeenCalled();
		expect(consentDialog()).toBeNull();
		expect(link().hidden).toBe(true);
		expect(link().textContent).toBe("Memory and privacy");
	});

	it("asks a signed-in user who has not answered, once per sign-in", async () => {
		const loadConsent = vi.fn(async (): Promise<ConsentResponse> => ({ consent: null, policyVersion: 1 }));
		const privacy = initPrivacy({ subscribe, loadConsent });
		emit(signedIn);
		emit(signedIn);
		await privacy.settled();
		await vi.waitFor(() => expect(consentDialog()?.open).toBe(true));
		expect(loadConsent).toHaveBeenCalledOnce();
		expect(link().hidden).toBe(false);
	});

	it("does not ask someone who already answered this policy", async () => {
		const privacy = initPrivacy({
			subscribe,
			loadConsent: async () => ({ consent: { history: true, memory: false, policyVersion: 1, updatedAt: 1 }, policyVersion: 1 }),
		});
		emit(signedIn);
		await privacy.settled();
		expect(consentDialog()).toBeNull();
	});

	it("shows nothing when the consent check fails", async () => {
		const privacy = initPrivacy({ subscribe, loadConsent: async () => Promise.reject(new Error("offline")) });
		emit(signedIn);
		await privacy.settled();
		expect(consentDialog()).toBeNull();
	});

	it("closes the consent dialog on sign-out, without saving", async () => {
		const privacy = initPrivacy({ subscribe, loadConsent: async () => ({ consent: null, policyVersion: 1 }) });
		emit(signedIn);
		await privacy.settled();
		await vi.waitFor(() => expect(consentDialog()?.open).toBe(true));
		emit(guest);
		expect(consentDialog()?.open).toBe(false);
		expect(link().hidden).toBe(true);
	});

	it("opens the panel from the picker link and closes the picker first", async () => {
		const closePicker = vi.fn();
		const privacy = initPrivacy({
			subscribe,
			closePicker,
			loadConsent: async () => ({ consent: { history: true, memory: false, policyVersion: 1, updatedAt: 1 }, policyVersion: 1 }),
		});
		emit(signedIn);
		await privacy.settled();
		link().click();
		await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>("dialog.memory-dialog")?.open).toBe(true));
		expect(closePicker).toHaveBeenCalledOnce();
	});
});
