import { describe, expect, it } from "vitest";
import { createChunkParser, ModelEvent } from "../src/ai/parse";

function join(events: ModelEvent[], type: ModelEvent["type"]): string {
	return events.filter((e) => e.type === type).map((e) => e.text).join("");
}

describe("createChunkParser", () => {
	it("reads the Workers AI native shape", () => {
		const parser = createChunkParser("none");
		expect(parser.parse({ response: "Hello" })).toEqual([{ type: "text", text: "Hello" }]);
		expect(parser.parse({ response: "" })).toEqual([]);
		expect(parser.parse({})).toEqual([]);
		expect(parser.parse(null)).toEqual([]);
		expect(parser.parse("junk")).toEqual([]);
	});

	it("reads the OpenAI-compatible delta shape, including reasoning", () => {
		const parser = createChunkParser("field");
		expect(parser.parse({ choices: [{ delta: { content: "Hi" } }] })).toEqual([
			{ type: "text", text: "Hi" },
		]);
		expect(parser.parse({ choices: [{ delta: { reasoning_content: "hmm" } }] })).toEqual([
			{ type: "reasoning", text: "hmm" },
		]);
		expect(parser.parse({ choices: [{ delta: { reasoning: "alt", content: "x" } }] })).toEqual([
			{ type: "reasoning", text: "alt" },
			{ type: "text", text: "x" },
		]);
	});

	it("records usage from the final chunk", () => {
		const parser = createChunkParser("none");
		expect(parser.usage()).toBeNull();
		parser.parse({ response: "", usage: { prompt_tokens: 12, completion_tokens: 3 } });
		expect(parser.usage()).toEqual({ promptTokens: 12, completionTokens: 3 });
	});

	describe("think-tags", () => {
		it("splits a complete block out of one chunk", () => {
			const parser = createChunkParser("think-tags");
			const events = parser.parse({ response: "<think>plan</think>answer" });
			expect(events).toEqual([
				{ type: "reasoning", text: "plan" },
				{ type: "text", text: "answer" },
			]);
		});

		it("handles a tag split across chunks", () => {
			const parser = createChunkParser("think-tags");
			const all: ModelEvent[] = [];
			for (const piece of ["<thi", "nk>reas", "on</th", "ink>reply"]) {
				all.push(...parser.parse({ response: piece }));
			}
			all.push(...parser.flush());
			expect(join(all, "reasoning")).toBe("reason");
			expect(join(all, "text")).toBe("reply");
		});

		it("handles one character per chunk", () => {
			const parser = createChunkParser("think-tags");
			const all: ModelEvent[] = [];
			for (const ch of "<think>a b</think>c d") all.push(...parser.parse({ response: ch }));
			all.push(...parser.flush());
			expect(join(all, "reasoning")).toBe("a b");
			expect(join(all, "text")).toBe("c d");
		});

		it("passes ordinary angle brackets through once they cannot be a tag", () => {
			const parser = createChunkParser("think-tags");
			const all: ModelEvent[] = [];
			for (const piece of ["x <", "b> y <thin", "g>"]) all.push(...parser.parse({ response: piece }));
			all.push(...parser.flush());
			expect(join(all, "text")).toBe("x <b> y <thing>");
			expect(join(all, "reasoning")).toBe("");
		});

		it("flushes an unterminated think block as reasoning", () => {
			const parser = createChunkParser("think-tags");
			const all = parser.parse({ response: "<think>never closed" });
			all.push(...parser.flush());
			expect(join(all, "reasoning")).toBe("never closed");
			expect(join(all, "text")).toBe("");
		});

		it("leaves text alone when the model never thinks", () => {
			const parser = createChunkParser("think-tags");
			const all = parser.parse({ response: "plain answer" });
			all.push(...parser.flush());
			expect(all).toEqual([{ type: "text", text: "plain answer" }]);
		});
	});
});
