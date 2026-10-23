/**
 * The sidebar's options menus (M4.4): one menu open at a time, drawn inline
 * under its row so the sidebar's scroller never clips it.
 *
 * WAI-ARIA menu button: the trigger has aria-haspopup="menu" and
 * aria-expanded; opening focuses the first item; ArrowUp/ArrowDown (wrapping),
 * Home and End move; Enter or Space chooses; Escape closes and returns focus
 * to the trigger; Tab or a click elsewhere closes. An item with `submenu`
 * swaps the menu's items for the submenu's (Move to folder).
 */

export interface MenuItem {
	label: string;
	onSelect?(): void;
	submenu?: () => MenuItem[];
	/** Marks the current choice in a submenu. */
	checked?: boolean;
}

interface OpenMenu {
	trigger: HTMLButtonElement;
	element: HTMLElement;
	close(restoreFocus: boolean): void;
}

let current: OpenMenu | null = null;

export function isMenuOpen(): boolean {
	return current !== null;
}

export function closeMenu(restoreFocus = false): void {
	current?.close(restoreFocus);
}

/** Open a menu right after `anchor` for `trigger`, or close it if it is the one open. */
export function toggleMenu(
	trigger: HTMLButtonElement,
	anchor: HTMLElement,
	items: () => MenuItem[],
	onClose?: () => void,
): void {
	if (current?.trigger === trigger) {
		current.close(true);
		return;
	}
	current?.close(false);

	const menu = document.createElement("ul");
	menu.className = "sidebar-menu";
	menu.setAttribute("role", "menu");
	if (trigger.id) menu.setAttribute("aria-labelledby", trigger.id);
	else {
		const label = trigger.getAttribute("aria-label");
		if (label) menu.setAttribute("aria-label", label);
	}

	const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>("[role^='menuitem']")];

	function fill(list: MenuItem[]) {
		menu.replaceChildren(
			...list.map((item) => {
				const li = document.createElement("li");
				li.setAttribute("role", "none");
				const button = document.createElement("button");
				button.type = "button";
				button.className = "sidebar-menu-item";
				button.tabIndex = -1;
				button.textContent = item.label;
				if (item.checked !== undefined) {
					button.setAttribute("role", "menuitemradio");
					button.setAttribute("aria-checked", String(item.checked));
				} else {
					button.setAttribute("role", "menuitem");
				}
				if (item.submenu) button.setAttribute("aria-haspopup", "menu");
				button.addEventListener("click", (event) => {
					event.stopPropagation();
					if (item.submenu) {
						fill(item.submenu());
						buttons()[0]?.focus();
						return;
					}
					close(false);
					item.onSelect?.();
				});
				li.append(button);
				return li;
			}),
		);
	}

	function move(delta: number | "first" | "last") {
		const all = buttons();
		if (!all.length) return;
		const at = all.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			delta === "first" ? 0 : delta === "last" ? all.length - 1 : (at + delta + all.length) % all.length;
		all[next]?.focus();
	}

	menu.addEventListener("keydown", (event) => {
		switch (event.key) {
			case "ArrowDown":
				move(1);
				break;
			case "ArrowUp":
				move(-1);
				break;
			case "Home":
				move("first");
				break;
			case "End":
				move("last");
				break;
			case "Escape":
				event.stopPropagation();
				close(true);
				break;
			case "Tab":
				close(false);
				return;
			default:
				return;
		}
		event.preventDefault();
	});

	const outside = (event: PointerEvent) => {
		const target = event.target as Node | null;
		if (target && (menu.contains(target) || trigger.contains(target))) return;
		close(false);
	};

	let closed = false;
	function close(restoreFocus: boolean) {
		if (closed) return;
		closed = true;
		document.removeEventListener("pointerdown", outside, true);
		trigger.setAttribute("aria-expanded", "false");
		const hadFocus = menu.contains(document.activeElement);
		menu.remove();
		if (current?.element === menu) current = null;
		if (restoreFocus || hadFocus) trigger.focus();
		onClose?.();
	}

	fill(items());
	anchor.after(menu);
	trigger.setAttribute("aria-expanded", "true");
	document.addEventListener("pointerdown", outside, true);
	current = { trigger, element: menu, close };
	buttons()[0]?.focus();
}
