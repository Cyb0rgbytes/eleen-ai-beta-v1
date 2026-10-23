/**
 * The page's only route to the Worker's API.
 *
 * - Adds the Clerk session token when the caller is signed in. The token
 *   provider is injected by auth/clerk.ts so this module has no auth
 *   dependency of its own.
 * - Times out requests that hang before responding.
 * - Turns every failure into an ApiError with a kind the UI can design a
 *   state for: rate limited (with Retry-After), sign-in needed, forbidden
 *   model, validation, network, timeout, aborted, server.
 *
 * An ApiError never carries the request body. That matters for the keys
 * endpoint, whose body is a user's provider key: it must not reach a log,
 * an error message or the console through this path.
 */
import type { ChatRequestBody, ModelForbiddenBody } from "../../../src/shared/chat";
import type { ModelsDocument } from "../../../src/shared/models";
import { readEvents, type StreamEvent } from "./stream";

export type ApiErrorKind =
	| "rate-limited"
	| "unauthorized"
	| "forbidden"
	| "validation"
	| "network"
	| "timeout"
	| "aborted"
	| "server";

export class ApiError extends Error {
	readonly kind: ApiErrorKind;
	readonly status: number;
	/** Seconds until a rate limit resets, when the server said. */
	readonly retryAfter: number | null;
	/** For a forbidden model: why ("sign-in" or "key-required"). */
	readonly reason: ModelForbiddenBody["reason"] | null;

	constructor(
		kind: ApiErrorKind,
		message: string,
		options: { status?: number; retryAfter?: number | null; reason?: ModelForbiddenBody["reason"] | null } = {},
	) {
		super(message);
		this.name = "ApiError";
		this.kind = kind;
		this.status = options.status ?? 0;
		this.retryAfter = options.retryAfter ?? null;
		this.reason = options.reason ?? null;
	}
}

type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider = async () => null;

/** Called once by auth/clerk.ts after Clerk loads. */
export function setTokenProvider(provider: TokenProvider): void {
	tokenProvider = provider;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface RequestOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** JSON-serialised. Never included in an error. */
	body?: unknown;
	/** Raw body, sent as-is with the given content type (voice audio). */
	raw?: { data: Blob; type: string };
	/** Attach the Clerk token. */
	auth?: boolean;
	signal?: AbortSignal;
	/** Time allowed until response headers arrive. */
	timeoutMs?: number;
	query?: Record<string, string>;
}

function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if ("any" in AbortSignal) return AbortSignal.any(live);
	// Older engines: a manual fan-in.
	const controller = new AbortController();
	for (const s of live) {
		if (s.aborted) {
			controller.abort(s.reason);
			break;
		}
		s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
	}
	return controller.signal;
}

async function readErrorBody(response: Response): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = await response.json();
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Map a non-OK response to an ApiError. Exported for tests. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
	const body = await readErrorBody(response);
	const message = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
	const status = response.status;

	if (status === 429) {
		const header = Number(response.headers.get("retry-after"));
		return new ApiError("rate-limited", message, {
			status,
			retryAfter: Number.isFinite(header) && header > 0 ? header : null,
		});
	}
	if (status === 401) return new ApiError("unauthorized", message, { status });
	if (status === 403) {
		const reason = body.reason === "sign-in" || body.reason === "key-required" ? body.reason : null;
		return new ApiError("forbidden", message, { status, reason });
	}
	if (status === 400 || status === 413 || status === 415 || status === 422) {
		return new ApiError("validation", message, { status });
	}
	return new ApiError("server", message, { status });
}

/** fetch with auth, a header timeout and typed errors. Returns the OK response. */
export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = combineSignals([options.signal, timeout]);

	const headers = new Headers({ accept: "application/json, text/event-stream" });
	let body: BodyInit | undefined;
	if (options.raw) {
		headers.set("content-type", options.raw.type);
		body = options.raw.data;
	} else if (options.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(options.body);
	}
	if (options.auth) {
		const token = await tokenProvider();
		if (token) headers.set("authorization", `Bearer ${token}`);
	}

	const url = new URL(path, window.location.origin);
	for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);

	let response: Response;
	try {
		response = await fetch(url, { method: options.method ?? "GET", headers, body, signal });
	} catch (error) {
		if (options.signal?.aborted) throw new ApiError("aborted", "Request cancelled.");
		if (timeout.aborted) throw new ApiError("timeout", "The server took too long to respond.");
		throw new ApiError("network", error instanceof Error ? error.message : "Network error.");
	}

	if (!response.ok) throw await errorFromResponse(response);
	return response;
}

/**
 * Start a chat turn and yield its v2 events. The header timeout covers only
 * the wait for the stream to start; once tokens flow, a long reply is fine.
 */
export async function* streamChat(
	body: ChatRequestBody,
	options: { authenticated: boolean; signal?: AbortSignal },
): AsyncGenerator<StreamEvent, void, undefined> {
	const response = await request(options.authenticated ? "/api/chat" : "/api/chat/guest", {
		method: "POST",
		body: { ...body, protocol: 2 },
		auth: options.authenticated,
		signal: options.signal,
	});
	if (!response.body) throw new ApiError("server", "The reply had no body.");
	yield* readEvents(response.body, options.signal);
}

/** The model listing for the picker. Public, inference-free. */
export async function fetchModels(signal?: AbortSignal): Promise<ModelsDocument> {
	const response = await request("/api/v1/models", { signal, timeoutMs: 10_000 });
	return (await response.json()) as ModelsDocument;
}
