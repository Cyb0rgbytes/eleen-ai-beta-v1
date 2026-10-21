/**
 * The colour theme (DESIGN.md section 3).
 *
 * A reader chooses system, light or dark. "System" follows
 * prefers-color-scheme live; the other two override it. What lands on
 * <html> is always the resolved theme, data-theme="light" or "dark", so
 * tokens.css needs one selector per theme and nothing about the choice.
 *
 * web/public/prefs.js applies the stored choice before first paint with the
 * same key and values; this module owns it from then on. Storage may be
 * unavailable, so every access is guarded and the page works without it.
 */

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "eleen.theme";

/** The toggle's cycle, starting from the default. */
export const THEME_ORDER: readonly ThemePref[] = ["system", "light", "dark"];

const SYSTEM_LIGHT = "(prefers-color-scheme: light)";

export function readThemePref(): ThemePref {
	try {
		const stored = window.localStorage.getItem(THEME_KEY);
		if (stored === "light" || stored === "dark") return stored;
	} catch {
		// Storage blocked: fall through to the default.
	}
	return "system";
}

export function writeThemePref(pref: ThemePref): void {
	try {
		// "system" is the default, so it is stored as the absence of a choice.
		if (pref === "system") window.localStorage.removeItem(THEME_KEY);
		else window.localStorage.setItem(THEME_KEY, pref);
	} catch {
		// Not persisted; the choice still applies to this page.
	}
}

export function nextThemePref(pref: ThemePref): ThemePref {
	const index = THEME_ORDER.indexOf(pref);
	return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? "system";
}

function systemPrefersLight(): boolean {
	try {
		return window.matchMedia(SYSTEM_LIGHT).matches;
	} catch {
		return false;
	}
}

export function resolveTheme(pref: ThemePref, systemLight = systemPrefersLight()): Theme {
	if (pref === "system") return systemLight ? "light" : "dark";
	return pref;
}

export function applyTheme(pref: ThemePref): Theme {
	const theme = resolveTheme(pref);
	document.documentElement.dataset.theme = theme;
	return theme;
}

/**
 * Re-resolve "system" when the OS theme changes. Returns an unsubscribe.
 * A fixed light or dark choice ignores the change, which `current` decides
 * at the moment it happens.
 */
export function watchSystemTheme(current: () => ThemePref): () => void {
	let query: MediaQueryList;
	try {
		query = window.matchMedia(SYSTEM_LIGHT);
	} catch {
		return () => {};
	}
	const onChange = () => {
		if (current() === "system") applyTheme("system");
	};
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}
