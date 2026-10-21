/**
 * The theme and language toggles (M4.5), and the static page text that
 * index.html ships in English.
 *
 * Both toggles sit at the inline-start of the auth plate in the page
 * corner, so they are on screen in every auth state, including when Clerk
 * is unavailable and the plate would otherwise be empty.
 *
 * Theme switches live. Language reloads the page: UI strings are set once,
 * when each module builds its controls, across modules this one does not
 * own, and a half-translated page is worse than a reload. A reload starts
 * a new conversation, so when one is under way the reader is asked first.
 */
import { currentLang, setLang, t, type MessageKey } from "../i18n";
import { setIcon, type IconName } from "../ui/icons";
import { writeLangPref, readLangPref } from "./lang";
import { applyTheme, nextThemePref, readThemePref, watchSystemTheme, writeThemePref, type ThemePref } from "./theme";

const THEME_ICON: Record<ThemePref, IconName> = { system: "monitor", light: "sun", dark: "moon" };
const THEME_LABEL: Record<ThemePref, MessageKey> = { system: "themeSystem", light: "themeLight", dark: "themeDark" };

export interface PrefsOptions {
	/** True when switching language would throw away a conversation. */
	hasConversation?: () => boolean;
	/** Navigation, injectable for tests. */
	reload?: () => void;
	confirm?: (message: string) => boolean;
}

/** Text that index.html carries in English, in the current language. */
function translateStaticText(): void {
	const footer = document.querySelector(".gateway-container > footer > p");
	if (footer) footer.textContent = t("footer");
	const logo = document.querySelector<HTMLImageElement>(".logo-image");
	if (logo) logo.alt = t("logoAlt");
	const loader = document.getElementById("spline-loader");
	if (loader) {
		// Keep the pulsing dot; replace only the words after it.
		for (const node of [...loader.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
		loader.append(t("sceneLoading"));
	}
}

function themeToggle(): HTMLButtonElement {
	let pref = readThemePref();
	const button = document.createElement("button");
	button.type = "button";
	button.id = "theme-toggle";
	button.className = "pref-button";
	const label = document.createElement("span");
	label.className = "sr-only";
	button.append(label);

	const render = () => {
		applyTheme(pref);
		setIcon(button, THEME_ICON[pref]);
		label.textContent = t(THEME_LABEL[pref]);
		button.title = t(THEME_LABEL[pref]);
		button.dataset.pref = pref;
	};
	button.addEventListener("click", () => {
		pref = nextThemePref(pref);
		writeThemePref(pref);
		render();
	});
	watchSystemTheme(() => pref);
	render();
	return button;
}

function langToggle(options: PrefsOptions): HTMLButtonElement {
	const target = currentLang() === "ar" ? "en" : "ar";
	const button = document.createElement("button");
	button.type = "button";
	button.id = "lang-toggle";
	button.className = "pref-button lang-toggle";
	button.title = t("langToggleLabel");
	button.dataset.target = target;
	// The visible text is the other language's own name, in that language,
	// so it is also the accessible name and is spoken with the right voice.
	const text = document.createElement("span");
	text.className = "lang-toggle-text";
	text.lang = target;
	text.dir = target === "ar" ? "rtl" : "ltr";
	text.textContent = t("langToggle");
	button.append(text);
	setIcon(button, "translate");

	button.addEventListener("click", () => {
		const ask = options.confirm ?? ((message: string) => window.confirm(message));
		if (options.hasConversation?.() && !ask(t("langSwitchConfirm"))) return;
		writeLangPref(target);
		setLang(target);
		// Storage blocked: the reload would come back in the old language,
		// so stay on this page with the direction flipped instead.
		if (readLangPref() !== target) {
			translateStaticText();
			button.replaceWith(langToggle(options));
			return;
		}
		(options.reload ?? (() => window.location.reload()))();
	});
	return button;
}

/** Apply stored preferences and mount the two toggles. Call once, first. */
export function initPrefs(options: PrefsOptions = {}): void {
	// prefs.js has normally done this before first paint; repeating it here
	// covers a page where that script did not run.
	const lang = readLangPref();
	if (lang && lang !== currentLang()) setLang(lang);
	translateStaticText();

	const group = document.createElement("div");
	group.className = "prefs";
	group.setAttribute("role", "group");
	group.setAttribute("aria-label", t("prefsGroup"));
	group.append(themeToggle(), langToggle(options));

	const host = document.querySelector(".auth-container") ?? document.querySelector(".gateway-container > header");
	host?.prepend(group);
}
