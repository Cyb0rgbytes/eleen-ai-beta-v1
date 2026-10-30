/**
 * The Studio page's entry. Everyone gets the teaser until the server says
 * otherwise, so a failure of Clerk or the network leaves "Coming soon", not a
 * broken page.
 */
import "../styles/studio.css";
import { initAuth, type AuthState } from "../auth/clerk";
import { loadStudio, renderStudio, renderTeaser } from "./view";

const root = document.getElementById("studio-root");

async function show(state: AuthState): Promise<void> {
	if (!root) return;
	if (state.status !== "signed-in") return renderTeaser(root);
	try {
		const studio = await loadStudio();
		if (studio) renderStudio(root, studio);
		else renderTeaser(root);
	} catch {
		renderTeaser(root);
	}
}

if (root) {
	renderTeaser(root);
	void initAuth((state) => void show(state)).then(show);
}
