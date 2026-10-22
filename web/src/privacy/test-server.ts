/**
 * A fetch stub for the privacy tests: routes by "METHOD /path" and records
 * every call. Not shipped: only *.test.ts files import it.
 */
import { vi } from "vitest";

export interface Call {
	method: string;
	path: string;
	body: Record<string, unknown> | null;
}

export type Handler = (call: Call) => Response | Promise<Response>;

export function json(status: number, body?: unknown): Response {
	if (status === 204) return new Response(null, { status });
	return new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });
}

export function stubServer(routes: Record<string, Handler>) {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (url: URL, init: RequestInit = {}) => {
		const call: Call = {
			method: init.method ?? "GET",
			path: new URL(url).pathname,
			body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
		};
		calls.push(call);
		const handler = routes[`${call.method} ${call.path}`] ?? routes[`${call.method} *`];
		return handler ? handler(call) : json(404, { error: "Not found" });
	});
	return { calls, routes };
}
