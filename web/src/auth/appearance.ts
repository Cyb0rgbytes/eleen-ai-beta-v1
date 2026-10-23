/**
 * Clerk's sign-in and account popups in the page's own theme.
 *
 * Clerk derives its shades from these values itself, so they are literal
 * colours, not var(--…): they mirror tokens.css (dark :root and
 * [data-theme="light"]) and must move with it.
 */
import type { Theme } from "../prefs/theme";

export { THEME_CHANGE_EVENT } from "../prefs/theme";

export interface ClerkAppearance {
	variables: Record<string, string>;
}

const SHARED = {
	borderRadius: "10px", // --r-sm
	fontFamily: "Inter, system-ui, sans-serif",
};

const VARIABLES: Record<Theme, Record<string, string>> = {
	dark: {
		colorPrimary: "#635bf6", // --accent
		colorBackground: "#0f0f2a", // --surface-solid
		colorText: "#e8e8ff", // --text
		colorTextSecondary: "#8a8aba", // --text-faint
		colorInputBackground: "#15153a",
		colorInputText: "#e8e8ff",
		colorDanger: "#f87171", // --danger
		colorNeutral: "#e8e8ff",
	},
	light: {
		colorPrimary: "#5a51f0",
		colorBackground: "#ffffff",
		colorText: "#16163a",
		colorTextSecondary: "#66668a",
		colorInputBackground: "#f4f4fa",
		colorInputText: "#16163a",
		colorDanger: "#b91c1c",
		colorNeutral: "#16163a",
	},
};

export function currentTheme(): Theme {
	return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function clerkAppearance(theme: Theme = currentTheme()): ClerkAppearance {
	return { variables: { ...SHARED, ...VARIABLES[theme] } };
}
