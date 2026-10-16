/**
 * The four auth controls in the page corners, the signed-in chip and the
 * composer placeholder. This is the only code that shows or hides them.
 */
import { icon } from "../ui/icons";
import { t } from "../i18n";
import { type AuthState, openSignIn, openSignUp, signOut } from "./clerk";

function byId<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

function label(button: HTMLElement | null, text: string): void {
	const span = button?.querySelector("span");
	if (span) span.textContent = text;
}

/** Attach handlers and icons once. */
export function initAuthControls(): void {
	const login = byId("login-button");
	const signup = byId("signup-button");
	const logout = byId("logout-button");
	login?.prepend(icon("sign-in"));
	logout?.prepend(icon("sign-out"));
	label(login, t("login"));
	label(signup, t("signUp"));
	label(logout, t("logout"));
	label(byId("dock-signin"), t("signIn"));
	label(byId("dock-signup"), t("signUp"));

	login?.addEventListener("click", () => void openSignIn());
	byId("dock-signin")?.addEventListener("click", () => void openSignIn());
	signup?.addEventListener("click", () => void openSignUp());
	byId("dock-signup")?.addEventListener("click", () => void openSignUp());
	logout?.addEventListener("click", () => void signOut());
}

/** Reflect an auth state in every control. Safe to call before Clerk loads. */
export function renderAuth(state: AuthState): void {
	const signedIn = state.status === "signed-in";
	const unavailable = state.status === "unavailable";
	// With no auth there is nothing these could open, so they are hidden
	// rather than left as dead controls.
	const entry = !signedIn && !unavailable;

	for (const id of ["login-button", "signup-button"]) {
		const el = byId(id);
		if (el) el.hidden = !entry;
	}
	const logout = byId("logout-button");
	if (logout) logout.hidden = !signedIn;
	byId("auth-dock")?.classList.toggle("is-hidden", !entry);

	const info = byId("user-info");
	if (info) info.hidden = !signedIn;
	const avatar = byId<HTMLImageElement>("user-avatar");
	const name = byId("user-name");
	if (signedIn) {
		if (name) name.textContent = state.name;
		if (avatar) {
			// Clerk's own image, or none. The classic page fell back to a
			// third-party avatar service, which sent the user's name off-site.
			if (state.imageUrl) {
				avatar.src = state.imageUrl;
				avatar.hidden = false;
			} else {
				avatar.removeAttribute("src");
				avatar.hidden = true;
			}
		}
	}

	const input = byId<HTMLTextAreaElement>("user-input");
	if (input && !input.dataset.held) {
		input.placeholder = signedIn ? t("placeholder") : unavailable ? t("placeholderGuestMode") : t("placeholderGuest");
	}
}
