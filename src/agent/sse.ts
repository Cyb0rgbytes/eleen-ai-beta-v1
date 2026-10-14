/**
 * Collapse the chat handler's SSE stream into a single string.
 *
 * The MCP tools call handleChatRequest directly, which returns a
 * text/event-stream. An MCP client expects one text content block, so the
 * stream has to be drained and reassembled here.
 *
 * The framing matches what public/chat.js already parses: `data:` lines
 * carrying `{"response": "<delta>"}`, terminated by `data: [DONE]`.
 */

/** Ceiling on collected output, so a runaway generation cannot pin the isolate. */
const MAX_COLLECTED_BYTES = 256 * 1024;

/**
 * Control markers the system prompt instructs the model to emit for the web
 * UI. They are presentation directives for our own frontend, so they must not
 * reach an MCP client as if they were part of the answer.
 */
const CONTROL_PATTERNS: RegExp[] = [
	/\[IMG_GEN\][\s\S]*?\[\/IMG_GEN\]/g,
	/\[SUGGEST\][\s\S]*?\[\/SUGGEST\]/g,
	/\[TOOL:[a-z]+\]/gi,
];

export function stripControlMarkers(text: string): string {
	let out = text;
	for (const pattern of CONTROL_PATTERNS) {
		out = out.replace(pattern, "");
	}
	// An unterminated opening marker can survive a truncated stream.
	out = out.replace(/\[(?:IMG_GEN|SUGGEST)\][\s\S]*$/, "");
	return out.trim();
}

export async function collectSseText(response: Response): Promise<string> {
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();

	let buffered = "";
	let collected = "";
	let bytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			bytes += value.byteLength;
			buffered += decoder.decode(value, { stream: true });

			// Keep the trailing fragment: an event may be split across chunks.
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;

				const payload = trimmed.slice(5).trim();
				if (payload === "[DONE]") return stripControlMarkers(collected);
				if (!payload) continue;

				try {
					const parsed = JSON.parse(payload) as { response?: string };
					if (typeof parsed.response === "string") collected += parsed.response;
				} catch {
					// A malformed frame should not abort an otherwise good stream.
				}
			}

			if (bytes > MAX_COLLECTED_BYTES) break;
		}
	} finally {
		// Release the upstream connection even if we bailed out early.
		await reader.cancel().catch(() => {});
	}

	return stripControlMarkers(collected);
}
