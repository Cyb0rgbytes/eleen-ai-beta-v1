import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../../../src/shared/history";
import { cleanTitle, groupConversations, sortFolders } from "./store";

const conv = (id: string, updatedAt: number, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id,
	title: id,
	pinned: false,
	folderId: null,
	createdAt: 1,
	updatedAt,
	...extra,
});

describe("groupConversations", () => {
	it("shows each chat once: pinned wins, then its folder, else Recent", () => {
		const folders = [
			{ id: "f1", name: "Work", position: 0 },
			{ id: "f2", name: "Empty", position: 1 },
		];
		const groups = groupConversations(
			[
				conv("a", 1),
				conv("b", 5, { pinned: true }),
				conv("c", 3, { folderId: "f1" }),
				conv("d", 4, { pinned: true, folderId: "f1" }),
				conv("e", 9),
				conv("lost", 2, { folderId: "gone" }),
			],
			folders,
		);
		expect(groups.pinned.map((c) => c.id)).toEqual(["b", "d"]);
		expect(groups.byFolder.get("f1")?.map((c) => c.id)).toEqual(["c"]);
		expect(groups.byFolder.get("f2")).toEqual([]);
		// A chat in a folder the sidebar does not know stays visible in Recent.
		expect(groups.recent.map((c) => c.id)).toEqual(["e", "lost", "a"]);
	});

	it("orders folders by position, then name", () => {
		expect(
			sortFolders([
				{ id: "1", name: "b", position: 1 },
				{ id: "2", name: "z", position: 0 },
				{ id: "3", name: "a", position: 1 },
			]).map((f) => f.id),
		).toEqual(["2", "3", "1"]);
	});

	it("trims titles and caps them at 200 characters", () => {
		expect(cleanTitle("  hi  ")).toBe("hi");
		expect(cleanTitle("x".repeat(250))).toHaveLength(200);
	});
});
