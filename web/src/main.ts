/**
 * Entry point. Boot order matters:
 *
 *   1. Scene first. A 3D backdrop has nothing to do with auth, and it used
 *      to be stranded whenever Clerk failed.
 *   2. Chat, composer, voice, WebMCP: all usable as a guest.
 *   3. Auth last and best-effort. The composer is enabled after it on every
 *      path, success, absence or failure; that is the one guarantee the page
 *      must never lose (regression 6778bb2).
 *
 * Any uncaught failure during boot still ends with an enabled composer.
 */
import "./styles/index.css";
import { authState, initAuth, openSignIn, type AuthState } from "./auth/clerk";
import { initAuthControls, renderAuth } from "./auth/controls";
import { initComposer, type Composer } from "./chat/composer";
import { createChat, type ChatApi } from "./chat/controller";
import { createEmptyState, setGreetingName } from "./chat/empty";
import { initJumpPill } from "./chat/jump";
import { initPicker, type Picker } from "./chat/picker";
import { watchReader } from "./chat/scroll";
import { initVoiceOutToggle } from "./chat/speak";
import { initVoice } from "./chat/voice";
import { t } from "./i18n";
import { createKeysDialog, type KeysDialog } from "./keys/dialog";
import { initScene } from "./scene/spline";
import { revealIn } from "./ui/motion";
import { showToast } from "./ui/toast";
import { registerWebMcp } from "./webmcp";

declare global {
	interface Window {
		/** The page's chat API, used by WebMCP and kept stable for agents. */
		chat?: ChatApi;
	}
}

function enableComposerFallback(): void {
	const input = document.getElementById("user-input") as HTMLTextAreaElement | null;
	const send = document.getElementById("send-button") as HTMLButtonElement | null;
	if (input) input.disabled = false;
	if (send) send.disabled = false;
}

let picker: Picker | null = null;
let keys: KeysDialog | null = null;

/** The picker's locks and the keys form follow the auth state. */
let applied: AuthState["status"] | null = null;
function applyAuth(state: AuthState): void {
	if (state.status === "loading" || state.status === applied) return;
	applied = state.status;
	const signedIn = state.status === "signed-in";
	picker?.setSignedIn(signedIn);
	if (signedIn) void keys?.refresh();
	else keys?.reset();
}

function onAuthChange(state: AuthState, previous: AuthState): void {
	renderAuth(state);
	applyAuth(state);
	setGreetingName(document, state.status === "signed-in" ? state.name : null);
	if (state.status === "signed-in" && previous.status !== "signed-in") {
		showToast(t("welcomeBack", { name: state.name }), "success");
	} else if (state.status === "guest" && previous.status === "signed-in") {
		showToast(t("signedOut"));
	}
}

async function boot(): Promise<void> {
	initScene();

	const messages = document.getElementById("chat-messages");
	if (!messages) throw new Error("#chat-messages is missing");
	watchReader(messages);

	let composer: Composer | null = null;
	const jump = initJumpPill(messages, messages.parentElement ?? document.body);
	const emptyState = () => {
		const state = authState();
		return createEmptyState(state.status === "signed-in" ? state.name : null);
	};
	const chat = createChat({
		messages,
		onBusyChange: (busy) => {
			composer?.setBusy(busy);
			jump.setBusy(busy);
		},
		emptyState,
	});
	// The static welcome in the HTML is the no-JavaScript fallback.
	messages.replaceChildren(emptyState());
	composer = initComposer(chat);
	keys = createKeysDialog({
		onChange: (providers) => picker?.setKeys(providers),
		onClose: () => picker?.focusTrigger(),
	});
	const pickerRoot = document.getElementById("model-picker");
	if (pickerRoot) {
		picker = initPicker(pickerRoot, {
			onModelChange: (model, label) => chat.setModel(model, label),
			onModeChange: (mode) => chat.setMode(mode),
			openSignIn: () => void openSignIn(),
			openKeys: (provider) => keys?.open(provider),
		});
	}
	initVoice(chat);
	initVoiceOutToggle(chat.speaker);
	window.chat = chat;
	registerWebMcp(chat);

	const header = document.querySelector(".gateway-container > header");
	if (header) revealIn(header);

	initAuthControls();
	renderAuth(authState());
	try {
		const state = await initAuth(onAuthChange);
		renderAuth(state);
		applyAuth(state);
		setGreetingName(document, state.status === "signed-in" ? state.name : null);
		if (state.status === "unavailable") showToast(t("authUnavailable"), "error", 5000);
	} finally {
		composer.enable();
	}
}

boot().catch((error: unknown) => {
	console.error("Boot failed:", error);
	enableComposerFallback();
});
