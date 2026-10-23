import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../../../src/shared/history";
import { buildTree, childrenOf, deepestLeaf, defaultLeaf, pathTo, siblingInfo } from "./tree";

function msg(id: string, parentId: string | null, seq: number, role: "user" | "assistant" = "user"): StoredMessage {
	return {
		id,
		parentId,
		seq,
		role,
		content: id,
		reasoning: null,
		model: null,
		status: "complete",
		compareGroup: null,
		completionTokens: null,
		createdAt: seq,
	};
}

// u1 ─ a1 ─ u2 ─ a2
//    └ a1b (regenerated)
// u1b (edited first turn) ─ a3
const messages = [
	msg("u1", null, 1),
	msg("a1", "u1", 2, "assistant"),
	msg("u2", "a1", 3),
	msg("a2", "u2", 4, "assistant"),
	msg("a1b", "u1", 5, "assistant"),
	msg("u1b", null, 6),
	msg("a3", "u1b", 7, "assistant"),
];

describe("tree", () => {
	const tree = buildTree([...messages].reverse());

	it("groups siblings by parent, sorted by seq", () => {
		expect(childrenOf(tree, null).map((m) => m.id)).toEqual(["u1", "u1b"]);
		expect(childrenOf(tree, "u1").map((m) => m.id)).toEqual(["a1", "a1b"]);
		expect(childrenOf(tree, "a2")).toEqual([]);
	});

	it("walks root to leaf", () => {
		expect(pathTo(tree, "a2").map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
		expect(pathTo(tree, null)).toEqual([]);
		expect(pathTo(tree, "missing")).toEqual([]);
	});

	it("follows the newest child down", () => {
		expect(deepestLeaf(tree, "u1")).toBe("a1b");
		expect(deepestLeaf(tree, "a1")).toBe("a2");
		expect(deepestLeaf(tree, "a3")).toBe("a3");
		expect(defaultLeaf(tree)).toBe("a3");
		expect(defaultLeaf(buildTree([]))).toBeNull();
	});

	it("says where a message sits among its siblings", () => {
		expect(siblingInfo(tree, "a1")).toEqual({ index: 1, count: 2, prevId: null, nextId: "a1b" });
		expect(siblingInfo(tree, "a1b")).toEqual({ index: 2, count: 2, prevId: "a1", nextId: null });
		expect(siblingInfo(tree, "u1b")).toEqual({ index: 2, count: 2, prevId: "u1", nextId: null });
		expect(siblingInfo(tree, "u2")).toEqual({ index: 1, count: 1, prevId: null, nextId: null });
		expect(siblingInfo(tree, "missing")).toBeNull();
	});

	it("survives a cycle or a missing parent", () => {
		const broken = buildTree([msg("x", "y", 1), msg("y", "x", 2), msg("z", "gone", 3)]);
		expect(pathTo(broken, "x").map((m) => m.id)).toEqual(["y", "x"]);
		expect(pathTo(broken, "z").map((m) => m.id)).toEqual(["z"]);
		expect(deepestLeaf(broken, "x")).toBe("y");
	});
});
