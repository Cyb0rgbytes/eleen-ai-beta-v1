/** Reading request bodies that come from outside with a hard size limit. */

export class TooLarge extends Error {}

/**
 * The body, read with a hard cap. Content-Length is checked first as a fast
 * path, but a chunked body has none, so the stream itself is counted too.
 */
export async function readCapped(request: Request, max: number): Promise<Uint8Array> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) throw new TooLarge();
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw new TooLarge();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
