/**
 * The browser and the Worker must agree on the v2 event names. The encoder
 * is the source of truth; this pins the shared list to what it writes.
 */
import { describe, expect, it } from "vitest";
import { STREAM_EVENT_NAMES } from "../../src/shared/stream";
import { createEncoder } from "../../src/ai/sse";

describe("shared stream contract", () => {
	it("lists exactly the events the v2 encoder emits", () => {
		const v2 = createEncoder(2);
		const frames = [
			v2.meta({}),
			v2.reasoning("r"),
			v2.token("t"),
			v2.usage({ completionTokens: 1 }),
			v2.error("e"),
			v2.done(),
		].join("");
		const written = [...frames.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
		expect(written).toEqual([...STREAM_EVENT_NAMES]);
	});
});
