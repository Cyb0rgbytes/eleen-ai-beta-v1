/**
 * The UI string lookup. Language follows <html lang>; the toggle that sets
 * it ships in Phase 4, but every string already goes through here so
 * nothing built now has to be revisited.
 */
import { ar } from "./ar";
import { en, type MessageKey } from "./en";

export type { MessageKey } from "./en";

export type Lang = "en" | "ar";

export function currentLang(): Lang {
	return document.documentElement.lang === "ar" ? "ar" : "en";
}

/** Look up a string, filling {placeholders} from `vars`. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
	const template = (currentLang() === "ar" ? ar[key] : undefined) ?? en[key];
	return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Set language and direction together; they must never disagree. */
export function setLang(lang: Lang): void {
	document.documentElement.lang = lang;
	document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}
