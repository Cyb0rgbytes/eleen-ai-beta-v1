import { describe, expect, it } from "vitest";
import { extractMarkers } from "./markers";

describe("extractMarkers", () => {
	it("pulls suggestions and strips them from the text", () => {
		const out = extractMarkers("Answer.\n[SUGGEST]More?|Example|Why?[/SUGGEST]");
		expect(out.text).toBe("Answer.");
		expect(out.suggestions).toEqual(["More?", "Example", "Why?"]);
	});

	it("caps the number and length of suggestions", () => {
		const out = extractMarkers(`[SUGGEST]a|b|c|d|${"x".repeat(500)}[/SUGGEST]`);
		expect(out.suggestions).toEqual(["a", "b", "c"]);
		const long = extractMarkers(`[SUGGEST]${"y".repeat(500)}[/SUGGEST]`);
		expect(long.suggestions[0]).toHaveLength(120);
	});

	it("reads an image prompt, with or without the closing slash", () => {
		expect(extractMarkers("Here.[IMG_GEN]a red cube[/IMG_GEN]").imagePrompt).toBe("a red cube");
		expect(extractMarkers("Here.[IMG_GEN]a blue cube[IMG_GEN]").imagePrompt).toBe("a blue cube");
	});

	it("strips tool hints", () => {
		expect(extractMarkers("[TOOL:think] Thinking about it.").text).toBe("Thinking about it.");
	});

	it("hides a marker that is still streaming in", () => {
		expect(extractMarkers("Answer.\n[SUGG", { streaming: true }).text).toBe("Answer.");
		expect(extractMarkers("Answer.\n[SUGGEST]Mo", { streaming: true }).text).toBe("Answer.");
		expect(extractMarkers("Answer.\n[IMG_GEN]a cat in", { streaming: true }).text).toBe("Answer.");
		expect(extractMarkers("[TOOL:thi", { streaming: true }).text).toBe("");
		expect(extractMarkers("Answer [with brackets] stays", { streaming: true }).text).toBe("Answer [with brackets] stays");
		expect(extractMarkers("Array a[i", { streaming: true }).text).toBe("Array a[i");
	});

	it("keeps hostile chip text as plain text for the renderer to escape", () => {
		const out = extractMarkers('[SUGGEST]<img src=x onerror="window.__xss=1">[/SUGGEST]');
		expect(out.suggestions).toEqual(['<img src=x onerror="window.__xss=1">']);
	});
});
