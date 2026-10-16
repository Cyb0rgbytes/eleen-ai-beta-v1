/**
 * Inline SVG icons, built with DOM APIs.
 *
 * Path data comes from icons.data.ts, generated from Phosphor. Icons are
 * decorative by default (aria-hidden); a button's accessible name comes
 * from its own visually hidden label, per DESIGN.md section 9.
 */
import { ICON_DATA, type IconName } from "./icons.data";

export type { IconName } from "./icons.data";

const SVG_NS = "http://www.w3.org/2000/svg";

export function icon(name: IconName): SVGSVGElement {
	const data = ICON_DATA[name];
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 256 256");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	svg.classList.add("icon");
	svg.dataset.icon = name;
	if (data.mirror) svg.dataset.mirror = "";
	for (const d of data.paths) {
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

/** Swap an element's icon in place, keeping any other children. */
export function setIcon(host: Element, name: IconName): void {
	host.querySelector(":scope > svg.icon")?.remove();
	host.prepend(icon(name));
}
