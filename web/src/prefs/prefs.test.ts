import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initPrefs } from "./controls";
import { LANG_KEY } from "./lang";
import { nextThemePref, readThemePref, resolveTheme, THEME_KEY, writeThemePref } from "./theme";

function reset() {
	localStorage.clear();
	document.documentElement.lang = "en";
	document.documentElement.dir = "ltr";
	delete document.documentElement.dataset.theme;
	document.body.innerHTML = `
		<div id="spline-loader"><span class="dot"></span>Loading 3D scene</div>
		<div class="auth-container"><button id="login-button" class="auth-button"><span>Login</span></button></div>
		<div class="gateway-container"><header><img class="logo-image" alt=""></header><footer><p>x</p></footer></div>`;
}

beforeEach(reset);
afterEach(() => {
	vi.restoreAllMocks();
	reset();
});

describe("theme preference", () => {
	it("defaults to system and cycles system, light, dark", () => {
		expect(readThemePref()).toBe("system");
		expect(nextThemePref("system")).toBe("light");
		expect(nextThemePref("light")).toBe("dark");
		expect(nextThemePref("dark")).toBe("system");
	});

	it("stores light and dark, and stores system as no choice", () => {
		writeThemePref("light");
		expect(localStorage.getItem(THEME_KEY)).toBe("light");
		writeThemePref("system");
		expect(localStorage.getItem(THEME_KEY)).toBeNull();
	});

	it("ignores a stored value it does not know", () => {
		localStorage.setItem(THEME_KEY, "sepia");
		expect(readThemePref()).toBe("system");
	});

	it("resolves system from the OS, and a fixed choice regardless of it", () => {
		expect(resolveTheme("system", true)).toBe("light");
		expect(resolveTheme("system", false)).toBe("dark");
		expect(resolveTheme("dark", true)).toBe("dark");
		expect(resolveTheme("light", false)).toBe("light");
	});

	it("works when storage throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(readThemePref()).toBe("system");
		expect(() => writeThemePref("dark")).not.toThrow();
		expect(() => initPrefs()).not.toThrow();
	});
});

describe("initPrefs", () => {
	it("mounts both toggles at the start of the auth plate", () => {
		initPrefs();
		const plate = document.querySelector(".auth-container");
		const group = plate?.firstElementChild;
		expect(group?.className).toBe("prefs");
		expect(group?.getAttribute("role")).toBe("group");
		expect(group?.querySelector("#theme-toggle")).not.toBeNull();
		expect(group?.querySelector("#lang-toggle")).not.toBeNull();
	});

	it("cycles the theme on click, with a visible name and a stored choice", () => {
		initPrefs();
		const button = document.querySelector<HTMLButtonElement>("#theme-toggle");
		expect(button?.dataset.pref).toBe("system");
		expect(button?.textContent).toBe("Theme: match system");
		button?.click();
		expect(button?.dataset.pref).toBe("light");
		expect(document.documentElement.dataset.theme).toBe("light");
		expect(localStorage.getItem(THEME_KEY)).toBe("light");
		expect(button?.querySelector("svg")?.dataset.icon).toBe("sun");
		button?.click();
		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(button?.title).toBe("Theme: dark");
	});

	it("offers Arabic in Arabic, and switches language and direction together", () => {
		const reload = vi.fn();
		initPrefs({ reload });
		const button = document.querySelector<HTMLButtonElement>("#lang-toggle");
		const text = button?.querySelector(".lang-toggle-text");
		expect(text?.textContent).toBe("العربية");
		expect(text?.getAttribute("lang")).toBe("ar");
		button?.click();
		expect(document.documentElement.lang).toBe("ar");
		expect(document.documentElement.dir).toBe("rtl");
		expect(localStorage.getItem(LANG_KEY)).toBe("ar");
		expect(reload).toHaveBeenCalledOnce();
	});

	it("asks before a switch would clear a conversation, and stays put on no", () => {
		const reload = vi.fn();
		const confirm = vi.fn(() => false);
		initPrefs({ reload, confirm, hasConversation: () => true });
		document.querySelector<HTMLButtonElement>("#lang-toggle")?.click();
		expect(confirm).toHaveBeenCalledOnce();
		expect(reload).not.toHaveBeenCalled();
		expect(document.documentElement.lang).toBe("en");
	});

	it("applies a stored language and translates the page's static text", () => {
		localStorage.setItem(LANG_KEY, "ar");
		initPrefs();
		expect(document.documentElement.dir).toBe("rtl");
		expect(document.querySelector("footer p")?.textContent).toContain("بدعم من");
		expect(document.getElementById("spline-loader")?.textContent).toBe("جارٍ تحميل المشهد ثلاثي الأبعاد");
		expect(document.querySelector(".dot")).not.toBeNull();
		expect(document.querySelector("#lang-toggle .lang-toggle-text")?.textContent).toBe("English");
	});

	it("keeps the footer's links when it translates the footer", () => {
		document.querySelector("footer p")!.innerHTML = 'EleenAI · <a href="/privacy">Privacy</a>';
		localStorage.setItem(LANG_KEY, "ar");
		initPrefs();
		const link = document.querySelector<HTMLAnchorElement>("footer p a");
		expect(link?.getAttribute("href")).toBe("/privacy");
		expect(link?.textContent).toBe("الخصوصية");
		expect(document.querySelector("footer p")?.textContent).toContain("بدعم من");
	});
});
