/**
 * Clerk, best-effort.
 *
 * The SDK is clerk-js 5.128.0 served from clerk.eleenai.xyz by a <script>
 * in index.html. It stays on the v5 line: the v6 browser bundle has no
 * sign-in UI, and every Login click threw. Do not bump it to 6.
 *
 * Guests are first-class (they chat on /api/chat/guest), so losing auth
 * must never cost them the composer. initAuth() always resolves; the
 * caller enables the composer after it whatever happened, which is the
 * guarantee the old updateAuthUI()-in-finally gave (regression 6778bb2).
 */
import { setTokenProvider } from "../api/client";
import { THEME_CHANGE_EVENT, clerkAppearance, type ClerkAppearance } from "./appearance";

/** The parts of the Clerk browser SDK this page uses. clerk-js ships no
 *  types for the global, so the shape is declared here. */
interface ClerkUser {
	id: string;
	fullName?: string | null;
	imageUrl?: string | null;
	primaryEmailAddress?: { emailAddress: string } | null;
}

interface ClerkGlobal {
	loaded: boolean;
	user?: ClerkUser | null;
	session?: { getToken(): Promise<string | null> } | null;
	load(options: { publishableKey: string; appearance?: ClerkAppearance }): Promise<void>;
	addListener(listener: (state: { user?: ClerkUser | null }) => void): () => void;
	openSignIn(props?: { appearance?: ClerkAppearance }): void;
	openSignUp(props?: { appearance?: ClerkAppearance }): void;
	signOut(): Promise<void>;
	/** clerk-js v5: re-themes components already mounted. Not public API, so optional. */
	__unstable__updateProps?(props: { appearance?: ClerkAppearance }): void;
}

declare global {
	interface Window {
		Clerk?: ClerkGlobal;
	}
}

/** Production instance, frontend API at clerk.eleenai.xyz. Must match the
 *  SDK <script> host in index.html and CLERK_PUBLISHABLE_KEY in wrangler. */
export const CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuZWxlZW5haS54eXok";

const SDK_WAIT_MS = 5000;

export type AuthState =
	| { status: "loading" }
	| { status: "unavailable" }
	| { status: "guest" }
	| { status: "signed-in"; name: string; imageUrl: string | null };

let clerk: ClerkGlobal | null = null;
let settled = false;

/** Settles once initAuth has finished, either way. */
let markReady: () => void = () => {};
const ready = new Promise<void>((resolve) => (markReady = resolve));

function stateOf(user: ClerkUser | null | undefined): AuthState {
	// Before Clerk has had its chance the entry controls stay visible: a
	// click then waits for Clerk (see openSignIn) instead of finding no button.
	if (!settled) return { status: "loading" };
	if (!clerk) return { status: "unavailable" };
	if (!user) return { status: "guest" };
	return {
		status: "signed-in",
		name: user.fullName || user.primaryEmailAddress?.emailAddress || "User",
		imageUrl: user.imageUrl || null,
	};
}

export function authState(): AuthState {
	return stateOf(clerk?.user);
}

export function isSignedIn(): boolean {
	return Boolean(clerk?.session);
}

type AuthListener = (state: AuthState) => void;
const listeners = new Set<AuthListener>();

function emit(state: AuthState): void {
	for (const listener of listeners) {
		try {
			listener(state);
		} catch (error) {
			console.error("Auth listener failed:", error);
		}
	}
}

/**
 * Follow the auth state from anywhere, without threading a callback through
 * main.ts: called once settled (or at once if it already is), then on every
 * sign-in and sign-out. Returns the unsubscribe.
 */
export function subscribeAuth(listener: AuthListener): () => void {
	listeners.add(listener);
	if (settled) listener(authState());
	return () => listeners.delete(listener);
}

async function waitForSdk(): Promise<ClerkGlobal | null> {
	const started = Date.now();
	while (!window.Clerk) {
		if (Date.now() - started > SDK_WAIT_MS) return null;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return window.Clerk;
}

/**
 * Load Clerk and wire the token into the API client. Never throws; returns
 * the resulting state. `onChange` fires on every later sign-in or sign-out.
 */
export async function initAuth(onChange: (state: AuthState, previous: AuthState) => void): Promise<AuthState> {
	try {
		const sdk = await waitForSdk();
		if (!sdk) throw new Error("Clerk SDK did not load within 5s.");
		if (!sdk.loaded) await sdk.load({ publishableKey: CLERK_PUBLISHABLE_KEY, appearance: clerkAppearance() });
		clerk = sdk;
		settled = true;
		document.documentElement.addEventListener(THEME_CHANGE_EVENT, () => {
			try {
				clerk?.__unstable__updateProps?.({ appearance: clerkAppearance() });
			} catch {
				// Older SDK: the next popup still opens in the new theme.
			}
		});

		setTokenProvider(async () => {
			try {
				return (await clerk?.session?.getToken()) ?? null;
			} catch {
				return null;
			}
		});

		let previous = authState();
		sdk.addListener(({ user }) => {
			const next = stateOf(user);
			onChange(next, previous);
			previous = next;
			emit(next);
		});
		return previous;
	} catch (error) {
		console.error("Auth unavailable, continuing as guest:", error instanceof Error ? error.message : error);
		clerk = null;
		return { status: "unavailable" };
	} finally {
		settled = true;
		markReady();
		emit(authState());
	}
}

/**
 * Clerk can take several seconds to load. A click on Login before then used
 * to do nothing at all; now it waits for Clerk and opens the modal. If Clerk
 * never comes up the controls are hidden, so the wait cannot strand anyone.
 */
export async function openSignIn(): Promise<void> {
	await ready;
	// The theme at the moment it opens, not at load.
	clerk?.openSignIn({ appearance: clerkAppearance() });
}

export async function openSignUp(): Promise<void> {
	await ready;
	clerk?.openSignUp({ appearance: clerkAppearance() });
}

export async function signOut(): Promise<void> {
	await clerk?.signOut();
}
