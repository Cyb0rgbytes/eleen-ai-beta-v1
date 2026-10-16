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
	load(options: { publishableKey: string }): Promise<void>;
	addListener(listener: (state: { user?: ClerkUser | null }) => void): () => void;
	openSignIn(): void;
	openSignUp(): void;
	signOut(): Promise<void>;
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
	| { status: "unavailable" }
	| { status: "guest" }
	| { status: "signed-in"; name: string; imageUrl: string | null };

let clerk: ClerkGlobal | null = null;

function stateOf(user: ClerkUser | null | undefined): AuthState {
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
		if (!sdk.loaded) await sdk.load({ publishableKey: CLERK_PUBLISHABLE_KEY });
		clerk = sdk;

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
		});
		return previous;
	} catch (error) {
		console.error("Auth unavailable, continuing as guest:", error instanceof Error ? error.message : error);
		clerk = null;
		return { status: "unavailable" };
	}
}

export function openSignIn(): void {
	clerk?.openSignIn();
}

export function openSignUp(): void {
	clerk?.openSignUp();
}

export async function signOut(): Promise<void> {
	await clerk?.signOut();
}
