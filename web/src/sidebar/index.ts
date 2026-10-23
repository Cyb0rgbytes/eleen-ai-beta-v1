/**
 * The sidebar's entry in the initial bundle (M4.4): only the rule for when
 * it shows. The sidebar itself is a dynamic import, fetched the first time
 * a signed-in user's consent is known, so a guest never downloads it.
 *
 *   guest, or consent not read yet   hidden
 *   signed in, history off           "off": New chat and a hint
 *   signed in, history on            "saved": the full sidebar
 */
import { subscribeHistory, type HistoryState } from "../history/state";
import type { Sidebar, SidebarChat, SidebarMode } from "./sidebar";

export interface SidebarInit {
	chat: SidebarChat;
	openPrivacy(): void;
}

export function sidebarMode(state: HistoryState): SidebarMode {
	if (!state.signedIn || state.historyOn === null) return "hidden";
	return state.historyOn ? "saved" : "off";
}

export function initSidebar(init: SidebarInit): void {
	let sidebar: Sidebar | null = null;
	let loading: Promise<void> | null = null;
	let wanted: SidebarMode = "hidden";

	subscribeHistory((state) => {
		wanted = sidebarMode(state);
		if (sidebar) {
			sidebar.setMode(wanted);
			return;
		}
		if (wanted === "hidden" || loading) return;
		loading = import("./sidebar")
			.then(({ createSidebar }) => {
				sidebar = createSidebar(init);
				sidebar.setMode(wanted);
			})
			.catch((error: unknown) => {
				// The chat works without it; the next sign-in tries again.
				console.error("Sidebar failed to load:", error);
				loading = null;
			});
	});
}
