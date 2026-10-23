/**
 * The sidebar's open and closed states (DESIGN.md section 7, M4.4).
 *
 * - At 1024px and wider it is pinned beside the chat, open by default; the
 *   chat column moves over (the root's data-sidebar="open") so nothing is
 *   covered. Collapsing it is remembered in localStorage.
 * - Narrower, it is an off-canvas drawer over a scrim, closed by default.
 *   Opening moves focus into it, Escape or the scrim closes it, and focus
 *   goes back to the toggle.
 *
 * Closed, the panel is inert, so it is out of the tab order and the
 * accessibility tree while it slides away.
 */
import { t } from "../i18n";
import { icon } from "../ui/icons";

export const DESKTOP_QUERY = "(min-width: 1024px)";
const STORAGE_KEY = "eleen.sidebar";

export interface DrawerOptions {
	panel: HTMLElement;
	toggle: HTMLButtonElement;
	scrim: HTMLElement;
	/** Where focus goes when the drawer opens on a small screen. */
	focusTarget(): HTMLElement | null;
}

export interface Drawer {
	setAvailable(available: boolean): void;
	open(options?: { focus?: boolean }): void;
	close(options?: { focus?: boolean }): void;
	isOpen(): boolean;
	isDesktop(): boolean;
	/** Close if it is the off-canvas drawer: after choosing a chat on a phone. */
	closeIfDrawer(): void;
}

function readCollapsed(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "collapsed";
	} catch {
		return false;
	}
}

function writeCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, collapsed ? "collapsed" : "open");
	} catch {
		// Storage blocked: the choice lasts for this page only.
	}
}

export function createDrawer(options: DrawerOptions): Drawer {
	const { panel, toggle, scrim } = options;
	const root = document.documentElement;
	const media = typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_QUERY) : null;
	const isDesktop = () => media?.matches ?? false;

	let available = false;
	let open = false;

	const label = document.createElement("span");
	label.className = "sr-only";
	toggle.replaceChildren(icon("sidebar-simple"), label);
	toggle.setAttribute("aria-controls", panel.id);

	function apply() {
		panel.hidden = !available;
		toggle.hidden = !available;
		panel.inert = !open;
		panel.classList.toggle("is-open", open);
		panel.classList.toggle("is-drawer", !isDesktop());
		scrim.hidden = !(available && open && !isDesktop());
		toggle.setAttribute("aria-expanded", String(available && open));
		label.textContent = t(open ? "sidebarClose" : "sidebarOpen");
		if (available) root.dataset.sidebar = open ? "open" : "closed";
		else delete root.dataset.sidebar;
	}

	function setOpen(next: boolean, focus: boolean) {
		open = next;
		apply();
		if (!focus) return;
		if (open) options.focusTarget()?.focus();
		else toggle.focus();
	}

	toggle.addEventListener("click", () => {
		const next = !open;
		if (isDesktop()) writeCollapsed(!next);
		setOpen(next, !isDesktop() || !next);
	});
	scrim.addEventListener("click", () => setOpen(false, true));
	panel.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.defaultPrevented || !open || isDesktop()) return;
		event.preventDefault();
		setOpen(false, true);
	});
	media?.addEventListener?.("change", () => {
		// Crossing the breakpoint: desktop follows the saved choice, a phone starts closed.
		open = isDesktop() ? !readCollapsed() : false;
		apply();
	});

	apply();
	return {
		setAvailable(next) {
			if (next === available) return;
			available = next;
			open = available && isDesktop() && !readCollapsed();
			apply();
		},
		open: ({ focus = true } = {}) => setOpen(true, focus),
		close: ({ focus = true } = {}) => setOpen(false, focus),
		isOpen: () => open,
		isDesktop,
		closeIfDrawer() {
			if (open && !isDesktop()) setOpen(false, false);
		},
	};
}
