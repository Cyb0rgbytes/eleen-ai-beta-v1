import { describe, expect, it } from "vitest";
import type { StoredMessage } from "../../../src/shared/history";
import { buildTree, childrenOf, compareMembers, deepestLeaf, defaultLeaf, pathTo, siblingInfo, slotsOf } from "./tree";

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

	it("counts a compare group once among its siblings (M5.4)", () => {
		// q ─ r1 (single), then c0 | c1 | c2 (one compare turn), then r2 (regenerated)
		// c1 was continued from: c1 ─ q2 ─ r3
		const g = (m: StoredMessage) => ({ ...m, compareGroup: "g" });
		const compared = buildTree([
			msg("q", null, 1),
			msg("r1", "q", 2, "assistant"),
			g(msg("c0", "q", 3, "assistant")),
			g(msg("c1", "q", 4, "assistant")),
			g(msg("c2", "q", 5, "assistant")),
			msg("q2", "c1", 6),
			msg("r3", "q2", 7, "assistant"),
			msg("r2", "q", 8, "assistant"),
		]);
		expect(slotsOf(compared, "q").map((s) => [s.ids, s.primary, s.group])).toEqual([
			[["r1"], "r1", null],
			[["c0", "c1", "c2"], "c1", "g"],
			[["r2"], "r2", null],
		]);
		for (const id of ["c0", "c1", "c2"]) {
			expect(siblingInfo(compared, id)).toEqual({ index: 2, count: 3, prevId: "r1", nextId: "r2" });
		}
		expect(siblingInfo(compared, "r2")).toEqual({ index: 3, count: 3, prevId: "c1", nextId: null });
		expect(compareMembers(compared, "c2")?.map((m) => m.id)).toEqual(["c0", "c1", "c2"]);
		expect(compareMembers(compared, "r1")).toBeNull();
		// Into the compare turn through the lane that was continued from.
		expect(deepestLeaf(compared, "c1")).toBe("r3");
		expect(deepestLeaf(compared, "r1")).toBe("r1");
	});

	it("walks a compare turn nobody continued from through its first lane", () => {
		const g = (m: StoredMessage) => ({ ...m, compareGroup: "g" });
		const compared = buildTree([msg("q", null, 1), g(msg("c0", "q", 2, "assistant")), g(msg("c1", "q", 3, "assistant"))]);
		expect(deepestLeaf(compared, "q")).toBe("c0");
		expect(defaultLeaf(compared)).toBe("c0");
		expect(siblingInfo(compared, "c1")).toEqual({ index: 1, count: 1, prevId: null, nextId: null });
	});

	it("survives a cycle or a missing parent", () => {
		const broken = buildTree([msg("x", "y", 1), msg("y", "x", 2), msg("z", "gone", 3)]);
		expect(pathTo(broken, "x").map((m) => m.id)).toEqual(["y", "x"]);
		expect(pathTo(broken, "z").map((m) => m.id)).toEqual(["z"]);
		expect(deepestLeaf(broken, "x")).toBe("y");
	});
});
