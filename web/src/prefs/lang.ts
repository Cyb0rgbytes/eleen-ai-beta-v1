/**
 * The stored UI language. setLang in ../i18n sets lang and dir together;
 * this only remembers the choice. web/public/prefs.js reads the same key
 * before first paint, so a reload comes back in the chosen language and
 * direction with no flash of the other.
 */
import type { Lang } from "../i18n";

export const LANG_KEY = "eleen.lang";

export function readLangPref(): Lang | null {
	try {
		const stored = window.localStorage.getItem(LANG_KEY);
		if (stored === "en" || stored === "ar") return stored;
	} catch {
		// Storage blocked: the HTML's language stands.
	}
	return null;
}

export function writeLangPref(lang: Lang): void {
	try {
		window.localStorage.setItem(LANG_KEY, lang);
	} catch {
		// Not persisted; this page still switches.
	}
}
