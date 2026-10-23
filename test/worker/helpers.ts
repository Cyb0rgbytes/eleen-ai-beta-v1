/**
 * Shared by the history tests: requests through the real Worker as a named
 * user, with a fake AI binding that records every call and never reaches a
 * model.
 *
 * The Worker's default export is called directly rather than through
 * exports.default so each test can hand it its own env (the fake AI, no
 * burst guard) and wait on its own ExecutionContext, which is where a saved
 * reply is written.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import type { Env } from "../../src/types";

export const ORIGIN = "https://eleenai.xyz";

/** The header the test authenticator reads (test/worker/history.test.ts installs it). */
export const TEST_USER_HEADER = "x-test-user";

export interface AiCall {
	model: string;
	input: { messages?: { role: string; content: string }[]; stream?: boolean; max_tokens?: number };
}

export type StreamEnd = "complete" | "hang" | "error";

export interface FakeAiOptions {
	/** Reply text chunks, each sent as one Workers AI SSE line. */
	reply?: string[];
	end?: StreamEnd;
	/** What the title call answers. */
	title?: string;
	/** What the memory call answers. */
	facts?: string;
	/** Compare (M5.4): a reply and an ending per model id, over `reply` and `end`. */
	byModel?: Record<string, { reply?: string[]; end?: StreamEnd; reject?: boolean }>;
}

function modelStream(chunks: string[], end: StreamEnd): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: chunks[index++] })}\n\n`));
				return;
			}
			if (end === "complete") {
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			} else if (end === "error") {
				controller.error(new Error("model stream failed"));
			} else {
				return new Promise<void>(() => {});
			}
		},
	});
}

export function fakeAi(options: FakeAiOptions = {}) {
	const calls: AiCall[] = [];
	const ai = {
		run: async (model: string, input: AiCall["input"]) => {
			calls.push({ model, input: structuredClone(input) });
			if (input.stream) {
				const own = options.byModel?.[model];
				if (own?.reject) throw new Error("model unavailable");
				return modelStream(own?.reply ?? options.reply ?? ["Hello", " there."], own?.end ?? options.end ?? "complete");
			}
			const text = JSON.stringify(input.messages ?? []);
			if (text.includes("You name chat conversations")) return { response: options.title ?? "A Generated Title" };
			return { response: options.facts ?? "[]" };
		},
	};
	const chatCalls = () => calls.filter((c) => c.input.stream);
	return { ai, calls, chatCalls };
}

export interface Sent {
	response: Response;
	ctx: ExecutionContext;
}

/** One request as `user` (null for signed out). */
export async function send(
	path: string,
	user: string | null,
	init: RequestInit = {},
	ai: ReturnType<typeof fakeAi>["ai"] = fakeAi().ai,
): Promise<Sent> {
	const headers = new Headers(init.headers);
	if (user) headers.set(TEST_USER_HEADER, user);
	if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
	const ctx = createExecutionContext();
	const testEnv = { ...env, AI: ai, BURST: undefined } as unknown as Env;
	const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), testEnv, ctx);
	return { response, ctx };
}

/** A JSON request; waits for any background work before returning. */
export async function api<T = unknown>(
	method: string,
	path: string,
	user: string | null,
	body?: unknown,
): Promise<{ status: number; body: T }> {
	const { response, ctx } = await send(path, user, {
		method,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

export interface ChatResult {
	status: number;
	raw: string;
	events: { event: string; data: Record<string, unknown> }[];
	meta: Record<string, unknown> | undefined;
}

function parseEvents(raw: string): ChatResult["events"] {
	return raw
		.split("\n\n")
		.filter((frame) => frame.startsWith("event: "))
		.map((frame) => {
			const [eventLine, dataLine] = frame.split("\n");
			return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) as Record<string, unknown> };
		});
}

/** A chat request read to the end, with its saved reply written. */
export async function chat(
	user: string | null,
	body: Record<string, unknown>,
	ai: ReturnType<typeof fakeAi>["ai"],
	path = user ? "/api/chat" : "/api/chat/guest",
): Promise<ChatResult> {
	const { response, ctx } = await send(path, user, { method: "POST", body: JSON.stringify(body) }, ai);
	let raw = "";
	if (response.body) {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				raw += decoder.decode(value, { stream: true });
			}
		} catch {
			// A stream that errors part-way: what arrived is enough.
		}
	}
	await waitOnExecutionContext(ctx);
	const events = parseEvents(raw);
	return { status: response.status, raw, events, meta: events.find((e) => e.event === "meta")?.data };
}

/** Read the first chunk of a chat stream, then cancel it as the Stop button does. */
export async function chatThenStop(
	user: string,
	body: Record<string, unknown>,
	ai: ReturnType<typeof fakeAi>["ai"],
): Promise<ChatResult> {
	const { response, ctx } = await send("/api/chat", user, { method: "POST", body: JSON.stringify(body) }, ai);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let raw = "";
	// Read until the first token has arrived, so there is something to save.
	while (!raw.includes("event: token")) {
		const { done, value } = await reader.read();
		if (done) break;
		raw += decoder.decode(value, { stream: true });
	}
	await reader.cancel();
	await waitOnExecutionContext(ctx);
	const events = parseEvents(raw);
	return { status: response.status, raw, events, meta: events.find((e) => e.event === "meta")?.data };
}
