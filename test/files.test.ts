/**
 * M5.2 pure pieces: type sniffing, the head-and-tail budget, and how images
 * reach a vision model.
 */
import { describe, expect, it } from "vitest";
import { decodeText, sniff } from "../src/files/sniff";
import { headAndTail } from "../src/files/context";
import { withImages } from "../src/ai/providers/gateway-compat";

const enc = (s: string) => new TextEncoder().encode(s);
const join = (...parts: (Uint8Array | number[])[]) => new Uint8Array(parts.flatMap((p) => Array.from(p)));

describe("sniff", () => {
	it.each([
		[enc("%PDF-1.7 ..."), "a.bin", "application/pdf"],
		[join([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0]), "a.pdf", "image/png"],
		[join([0xff, 0xd8, 0xff, 0xe0], [0, 0]), "a.txt", "image/jpeg"],
		[enc("GIF89a....."), "a", "image/gif"],
		[join(enc("RIFF"), [1, 2, 3, 4], enc("WEBPVP8 ")), "a", "image/webp"],
		[join([0x50, 0x4b, 0x03, 0x04], enc("x[Content_Types].xml y word/document.xml")), "a.zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
		[enc("hello, world"), "a.TXT", "text/plain"],
		[enc("# heading"), "notes.Markdown", "text/markdown"],
		[enc("a,b\n1,2"), "data.csv", "text/csv"],
		[enc("﻿مرحبا بالعالم"), "ar.txt", "text/plain"],
	])("recognises %#", (bytes, name, type) => {
		expect(sniff(bytes, name)?.type).toBe(type);
	});

	it.each([
		["an empty file", new Uint8Array(), "a.txt"],
		["a Windows executable named .pdf", join(enc("MZ"), [0x90, 0, 3, 0]), "a.pdf"],
		["a zip that is not a Word document", join([0x50, 0x4b, 0x03, 0x04], enc("readme.txt")), "a.docx"],
		["text with a NUL byte", join(enc("abc"), [0], enc("def")), "a.txt"],
		["invalid UTF-8", new Uint8Array([0x61, 0xc3, 0x28]), "a.txt"],
		["an ELF binary", join([0x7f], enc("ELF")), "a.txt"],
	])("refuses %s", (_label, bytes, name) => {
		expect(sniff(bytes, name)).toBeNull();
	});

	it("decodes text without changing it", () => {
		expect(decodeText(enc("tab\tand\r\nnewline"))).toBe("tab\tand\r\nnewline");
	});
});

describe("headAndTail", () => {
	it("leaves short text alone", () => {
		expect(headAndTail("short", 100)).toBe("short");
	});

	it("keeps the start and the end within the budget", () => {
		const text = `${"h".repeat(500)}${"m".repeat(1000)}${"t".repeat(500)}`;
		const cut = headAndTail(text, 1000);
		expect(cut.startsWith("h".repeat(500))).toBe(true);
		expect(cut.endsWith("t".repeat(300))).toBe(true);
		expect(cut).toContain("[... 1000 characters omitted ...]");
		expect(cut.length).toBeLessThan(1100);
	});
});

describe("withImages", () => {
	it("puts images on the newest user turn as image_url parts", () => {
		const messages = withImages({
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "first" },
				{ role: "assistant", content: "reply" },
				{ role: "user", content: "what is in this picture?" },
			],
			maxTokens: 10,
			route: "chat",
			images: [{ mimeType: "image/png", data: "AAAA" }],
		});
		expect(messages[1]).toEqual({ role: "user", content: "first" });
		expect(messages[3]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "what is in this picture?" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
			],
		});
	});

	it("leaves the messages alone without images", () => {
		const input = [{ role: "user" as const, content: "hi" }];
		expect(withImages({ messages: input, maxTokens: 1, route: "chat" })).toBe(input);
	});
});
