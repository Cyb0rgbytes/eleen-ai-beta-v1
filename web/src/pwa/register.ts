/**
 * Service worker registration and the update prompt (M5.5). The worker is
 * web/sw.js; what it caches, and what it never touches, is described there.
 *
 * Registered after the load event, so it never competes with the first
 * paint, and only on production-like origins: not on localhost or
 * 127.0.0.1, where a cached build would hide the change under test, unless
 * localStorage "eleen.sw" is "1" (the e2e suite sets it).
 *
 * Updates never interrupt a chat. A new worker waits (it does not skip
 * waiting on its own); this page offers a toast, and only when the reader
 * presses Reload does it tell the worker to take over and reload this tab.
 * Otherwise the new build arrives on the next load after the old tabs close.
 */
import { t } from "../i18n";
import { showToast } from "../ui/toast";

const SW_URL = "/sw.js";
const UPDATE_TOAST_MS = 30_000;

interface TrustedTypesLike {
	createPolicy(name: string, rules: { createScriptURL(url: string): string }): { createScriptURL(url: string): unknown };
}

export function swAllowed(location: Pick<Location, "hostname" | "protocol">, storage: Pick<Storage, "getItem"> | null): boolean {
	let forced = false;
	try {
		forced = storage?.getItem("eleen.sw") === "1";
	} catch {
		// Storage blocked: fall back to the origin rule.
	}
	if (forced) return true;
	if (location.protocol !== "https:") return false;
	return !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

function storage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

/** The worker's URL as a TrustedScriptURL where Trusted Types exist (the page's CSP reports on it). */
function scriptUrl(): string {
	const policy = (window as Window & { trustedTypes?: TrustedTypesLike }).trustedTypes?.createPolicy("eleenai-sw", {
		createScriptURL(url) {
			if (url !== SW_URL) throw new TypeError("Only the app's own service worker may be registered.");
			return url;
		},
	});
	return (policy?.createScriptURL(SW_URL) ?? SW_URL) as string;
}

function offerUpdate(worker: ServiceWorker): void {
	showToast(t("pwaUpdateReady"), "info", UPDATE_TOAST_MS, {
		action: {
			label: t("pwaUpdateReload"),
			onClick: () => {
				navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
				worker.postMessage({ type: "SKIP_WAITING" });
			},
		},
	});
}

async function register(): Promise<void> {
	const registration = await navigator.serviceWorker.register(scriptUrl(), { scope: "/" });
	// A worker already waiting from an earlier visit.
	if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
	registration.addEventListener("updatefound", () => {
		const installing = registration.installing;
		installing?.addEventListener("statechange", () => {
			// "installed" with a controller present means an update, not the first install.
			if (installing.state === "installed" && navigator.serviceWorker.controller) offerUpdate(installing);
		});
	});
}

export function initServiceWorker(): void {
	if (!("serviceWorker" in navigator) || !swAllowed(window.location, storage())) return;
	const start = () => {
		register().catch((error: unknown) => console.warn("Service worker registration failed:", error));
	};
	if (document.readyState === "complete") start();
	else window.addEventListener("load", start, { once: true });
}
