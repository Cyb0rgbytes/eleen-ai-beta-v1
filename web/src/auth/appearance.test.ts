import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, THEME_CHANGE_EVENT } from "../prefs/theme";
import { clerkAppearance, currentTheme } from "./appearance";

afterEach(() => {
	delete document.documentElement.dataset.theme;
});

describe("Clerk appearance", () => {
	it("follows data-theme, dark by default", () => {
		expect(currentTheme()).toBe("dark");
		const dark = clerkAppearance();
		document.documentElement.dataset.theme = "light";
		const light = clerkAppearance();
		expect(dark.variables.colorBackground).toBe("#0f0f2a");
		expect(light.variables.colorBackground).toBe("#ffffff");
		expect(light.variables.colorText).not.toBe(dark.variables.colorText);
		expect(light.variables.borderRadius).toBe(dark.variables.borderRadius);
	});

	it("uses literal colours only, which Clerk can derive shades from", () => {
		for (const theme of ["light", "dark"] as const) {
			for (const [name, value] of Object.entries(clerkAppearance(theme).variables)) {
				if (name.startsWith("color")) expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
			}
		}
	});

	it("announces a theme change once, not on a repeat", () => {
		const heard = vi.fn();
		document.documentElement.addEventListener(THEME_CHANGE_EVENT, heard);
		applyTheme("light");
		applyTheme("light");
		applyTheme("dark");
		document.documentElement.removeEventListener(THEME_CHANGE_EVENT, heard);
		expect(heard).toHaveBeenCalledTimes(2);
	});
});
