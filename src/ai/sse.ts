/**
 * The two stream encodings the chat endpoint can speak.
 *
 * v1 is a published contract: `data: {"response":"…"}` lines ending in
 * `data: [DONE]`. It is documented in docs.md, the chat skill and the OpenAPI
 * document, and the MCP server card's digest covers that documentation, so
 * it cannot change. Reasoning has no place in it and is dropped.
 *
 * v2 is opt-in (`"protocol": 2` in the request body) and uses named SSE
 * events so a client can render thinking separately from the answer, show
 * usage, and tell an error from a reply:
 *
 *   event: meta       data: {"model":"…","protocol":2}
 *   event: reasoning  data: {"text":"…"}
 *   event: token      data: {"text":"…"}
 *   event: usage      data: {"promptTokens":n,"completionTokens":n}
 *   event: error      data: {"message":"…"}
 *   event: done       data: {}
 */

import type { MetaPayload, Protocol, UsagePayload } from "../shared/stream";

// The event payloads are shared with the browser's decoder in web/src/api.
export type { Protocol } from "../shared/stream";

export interface SseEncoder {
	readonly protocol: Protocol;
	meta(fields: Omit<MetaPayload, "protocol">): string;
	token(text: string): string;
	reasoning(text: string): string;
	usage(fields: UsagePayload): string;
	/** A refusal or failure. In v1 it is rendered as reply text. */
	error(message: string): string;
	done(): string;
}

function v1Line(text: string): string {
	return `data: ${JSON.stringify({ response: text })}\n\n`;
}

function v2Event(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createEncoder(protocol: Protocol): SseEncoder {
	if (protocol === 1) {
		return {
			protocol: 1,
			meta: () => "",
			token: (text) => (text ? v1Line(text) : ""),
			reasoning: () => "",
			usage: () => "",
			error: (message) => v1Line(message),
			done: () => "data: [DONE]\n\n",
		};
	}

	return {
		protocol: 2,
		meta: (fields) => v2Event("meta", { ...fields, protocol: 2 }),
		token: (text) => (text ? v2Event("token", { text }) : ""),
		reasoning: (text) => (text ? v2Event("reasoning", { text }) : ""),
		usage: (fields) => v2Event("usage", fields),
		error: (message) => v2Event("error", { message }),
		done: () => v2Event("done", {}),
	};
}

export function isProtocol(value: unknown): value is Protocol {
	return value === 1 || value === 2;
}

/** The response headers every chat stream carries, whichever protocol. */
export const SSE_HEADERS: Record<string, string> = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache",
	connection: "keep-alive",
	"x-content-type-options": "nosniff",
};
