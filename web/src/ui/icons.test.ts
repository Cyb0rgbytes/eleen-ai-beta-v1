import { describe, expect, it } from "vitest";
import { icon, setIcon } from "./icons";
import { ICON_DATA } from "./icons.data";

describe("icon", () => {
	it("builds an aria-hidden svg with the glyph's paths", () => {
		const svg = icon("microphone");
		expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(svg.getAttribute("aria-hidden")).toBe("true");
		expect(svg.getAttribute("viewBox")).toBe("0 0 256 256");
		expect(svg.querySelectorAll("path")).toHaveLength(ICON_DATA.microphone.paths.length);
		expect(svg.hasAttribute("data-mirror")).toBe(false);
	});

	it("marks direction-aware glyphs for RTL mirroring", () => {
		expect(icon("sign-in").hasAttribute("data-mirror")).toBe(true);
		expect(icon("arrow-up").hasAttribute("data-mirror")).toBe(false);
	});

	it("replaces an existing icon without touching the label", () => {
		const button = document.createElement("button");
		const label = document.createElement("span");
		label.textContent = "Send";
		button.append(label);
		setIcon(button, "arrow-up");
		setIcon(button, "stop");
		expect(button.querySelectorAll("svg")).toHaveLength(1);
		expect(button.querySelector("svg")?.dataset.icon).toBe("stop");
		expect(button.textContent).toBe("Send");
	});
});
