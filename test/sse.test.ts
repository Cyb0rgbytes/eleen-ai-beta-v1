import { describe, expect, it } from "vitest";
import { createEncoder, isProtocol } from "../src/ai/sse";

describe("v1 encoder", () => {
	const v1 = createEncoder(1);

	it("emits the published data/[DONE] framing and nothing else", () => {
		expect(v1.token("TLS")).toBe('data: {"response":"TLS"}\n\n');
		expect(v1.done()).toBe("data: [DONE]\n\n");
		expect(v1.meta({ model: "x" })).toBe("");
		expect(v1.reasoning("thinking")).toBe("");
		expect(v1.usage({ promptTokens: 1 })).toBe("");
	});

	it("renders an error as reply text, as the old refusal did", () => {
		expect(v1.error("No.")).toBe('data: {"response":"No."}\n\n');
	});

	it("emits nothing for an empty token", () => {
		expect(v1.token("")).toBe("");
	});

	it("escapes JSON correctly", () => {
		expect(v1.token('say "hi"\n')).toBe('data: {"response":"say \\"hi\\"\\n"}\n\n');
	});
});

describe("v2 encoder", () => {
	const v2 = createEncoder(2);

	it("uses named events", () => {
		expect(v2.meta({ model: "m" })).toBe('event: meta\ndata: {"model":"m","protocol":2}\n\n');
		expect(v2.token("a")).toBe('event: token\ndata: {"text":"a"}\n\n');
		expect(v2.reasoning("r")).toBe('event: reasoning\ndata: {"text":"r"}\n\n');
		expect(v2.usage({ promptTokens: 2, completionTokens: 3 })).toBe(
			'event: usage\ndata: {"promptTokens":2,"completionTokens":3}\n\n',
		);
		expect(v2.error("bad")).toBe('event: error\ndata: {"message":"bad"}\n\n');
		expect(v2.done()).toBe("event: done\ndata: {}\n\n");
	});

	it("emits nothing for empty text", () => {
		expect(v2.token("")).toBe("");
		expect(v2.reasoning("")).toBe("");
	});
});

describe("isProtocol", () => {
	it("accepts only 1 and 2", () => {
		expect(isProtocol(1)).toBe(true);
		expect(isProtocol(2)).toBe(true);
		expect(isProtocol(3)).toBe(false);
		expect(isProtocol("2")).toBe(false);
		expect(isProtocol(undefined)).toBe(false);
	});
});
