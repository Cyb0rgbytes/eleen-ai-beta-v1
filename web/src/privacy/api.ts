/**
 * The browser's side of consent, memory and delete-all-history (M4.6),
 * against the contract in src/shared/history.ts.
 *
 * Every route is signed-in only. Everything read from the wire is checked
 * field by field before the UI sees it: a fact is model-derived text, so it
 * reaches the page as a string and nothing else.
 */
import { POLICY_VERSION, type Consent, type ConsentResponse, type ConsentUpdate, type MemoryEntry } from "../../../src/shared/history";
import { ApiError, request } from "../api/client";
import { setHistoryState } from "../history/state";

const TIMEOUT_MS = 10_000;

function parseConsent(value: unknown): Consent | null {
	if (typeof value !== "object" || value === null) return null;
	const c = value as Record<string, unknown>;
	if (typeof c.history !== "boolean" || typeof c.memory !== "boolean") return null;
	return {
		history: c.history,
		memory: c.memory,
		policyVersion: typeof c.policyVersion === "number" ? c.policyVersion : 0,
		updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
	};
}

function parseConsentResponse(value: unknown): ConsentResponse {
	const body = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	return {
		consent: parseConsent(body.consent),
		// A server that leaves it out is asking about the policy this page knows.
		policyVersion: typeof body.policyVersion === "number" ? body.policyVersion : POLICY_VERSION,
	};
}

/**
 * Whether to ask. Unanswered, or answered for an older policy. The two
 * defaults (history on, memory off) apply until then, server side.
 */
export function needsConsent(response: ConsentResponse): boolean {
	return response.consent === null || response.consent.policyVersion < response.policyVersion;
}

/** What the switches show before anyone has chosen: the contract's defaults. */
export const DEFAULT_CHOICES: ConsentUpdate = { history: true, memory: false };

export function choicesOf(response: ConsentResponse): ConsentUpdate {
	const c = response.consent;
	return c ? { history: c.history, memory: c.memory } : { ...DEFAULT_CHOICES };
}

export async function getConsent(signal?: AbortSignal): Promise<ConsentResponse> {
	const response = await request("/api/v1/consent", { auth: true, signal, timeoutMs: TIMEOUT_MS });
	return parseConsentResponse(await response.json());
}

export async function putConsent(update: ConsentUpdate): Promise<ConsentResponse> {
	const body: ConsentUpdate = { history: update.history, memory: update.memory };
	const response = await request("/api/v1/consent", { method: "PUT", body, auth: true, timeoutMs: TIMEOUT_MS });
	const parsed = parseConsentResponse(await response.json());
	// Whichever dialog saved it, the chat and the sidebar follow at once.
	setHistoryState({ historyOn: choicesOf(parsed).history });
	return parsed;
}

function parseEntry(value: unknown): MemoryEntry | null {
	if (typeof value !== "object" || value === null) return null;
	const e = value as Record<string, unknown>;
	if (typeof e.id !== "string" || !e.id || typeof e.fact !== "string") return null;
	return { id: e.id, fact: e.fact, createdAt: typeof e.createdAt === "number" ? e.createdAt : 0 };
}

export async function listMemory(signal?: AbortSignal): Promise<MemoryEntry[]> {
	const response = await request("/api/v1/memory", { auth: true, signal, timeoutMs: TIMEOUT_MS });
	const body = (await response.json()) as { entries?: unknown };
	return Array.isArray(body.entries) ? body.entries.map(parseEntry).filter((e): e is MemoryEntry => e !== null) : [];
}

/** A 404 means it is already gone, which is what the caller wanted. */
async function deleteRoute(path: string): Promise<boolean> {
	try {
		await request(path, { method: "DELETE", auth: true, timeoutMs: TIMEOUT_MS });
		return true;
	} catch (error) {
		return error instanceof ApiError && error.status === 404;
	}
}

export function forgetFact(id: string): Promise<boolean> {
	return deleteRoute(`/api/v1/memory/${encodeURIComponent(id)}`);
}

export function forgetAllMemory(): Promise<boolean> {
	return deleteRoute("/api/v1/memory");
}

export async function deleteAllConversations(): Promise<boolean> {
	try {
		await request("/api/v1/conversations", { method: "DELETE", auth: true, timeoutMs: 20_000 });
		return true;
	} catch {
		// Unlike one fact, a 404 here would mean the route is missing, not
		// that the history is gone.
		return false;
	}
}
