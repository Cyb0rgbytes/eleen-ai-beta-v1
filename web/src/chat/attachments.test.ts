import { describe, expect, it } from "vitest";
import { appendFileChips, formatSize, hasPendingUploads, takeFiles } from "./attachments";
import { createUserMessage, createUserTurn } from "./render";

describe("attachment chips on sent turns", () => {
	it("adds one chip per file inside the user bubble, names as text", () => {
		const turn = createUserTurn("see attached", "m1");
		appendFileChips(turn, [
			{ id: "f1", name: '<img src=x onerror="alert(1)">.pdf', type: "application/pdf", size: 2048, kind: "document" },
			{ id: "f2", name: "photo.png", type: "image/png", size: 3 * 1024 * 1024, kind: "image" },
		]);
		const chips = turn.querySelectorAll(".user-message .file-chips .file-chip");
		expect(chips).toHaveLength(2);
		expect(turn.querySelector("img")).toBeNull();
		expect(chips[0]?.querySelector(".file-chip-name")?.textContent).toBe('<img src=x onerror="alert(1)">.pdf');
		expect((chips[1] as HTMLElement).dataset.fileId).toBe("f2");
		expect(chips[1]?.querySelector(".file-chip-meta")?.textContent).toBe("3.0 MB");
	});

	it("works on a bare guest-style bubble and does nothing without files", () => {
		const bubble = createUserMessage("hi");
		appendFileChips(bubble, []);
		appendFileChips(bubble, undefined);
		expect(bubble.querySelector(".file-chips")).toBeNull();
		appendFileChips(bubble, [{ id: "f", name: "a.txt", type: "text/plain", size: 10, kind: "document" }]);
		expect(bubble.querySelectorAll(".file-chip")).toHaveLength(1);
	});
});

describe("the tray", () => {
	it("is empty before anything is attached", () => {
		expect(hasPendingUploads()).toBe(false);
		expect(takeFiles()).toEqual([]);
	});

	it("formats sizes", () => {
		expect(formatSize(10)).toBe("1 KB");
		expect(formatSize(512 * 1024)).toBe("512 KB");
		expect(formatSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
	});
});
