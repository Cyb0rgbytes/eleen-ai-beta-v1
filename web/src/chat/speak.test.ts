import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/clerk", () => ({ isSignedIn: () => false }));

import { MAX_SPOKEN_CHARS, createSpeaker, shouldAutoSpeak, toSpeech } from "./speak";

describe("toSpeech", () => {
	it("drops markers, markdown syntax, code and links, and keeps the words", () => {
		const raw = [
			"[TOOL:think]## Quick answer",
			"",
			"**Yes**, use a *hash* — see [the docs](https://example.com/docs).",
			"",
			"- first point",
			"1. second point",
			"",
			"```python",
			"print('hi')",
			"```",
			"",
			"Run `pip install x` then visit https://example.com.",
			"[SUGGEST]More?|Why?[/SUGGEST]",
		].join("\n");
		const spoken = toSpeech(raw);
		expect(spoken).toContain("Quick answer");
		expect(spoken).toContain("Yes, use a hash — see the docs.");
		expect(spoken).toContain("first point");
		expect(spoken).toContain("second point");
		expect(spoken).toContain("(code shown on screen)");
		expect(spoken).toContain("pip install x");
		for (const gone of ["**", "##", "```", "print(", "https://", "[TOOL", "SUGGEST", "More?"]) {
			expect(spoken).not.toContain(gone);
		}
	});

	it("cuts a long reply at a sentence end under the cap", () => {
		const raw = "This is one sentence. ".repeat(200);
		const spoken = toSpeech(raw);
		expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
		expect(spoken.endsWith(".")).toBe(true);
	});
});

describe("shouldAutoSpeak", () => {
	afterEach(() => localStorage.clear());

	it("speaks after a voice question by default, and never after a typed one", () => {
		expect(shouldAutoSpeak(true)).toBe(true);
		expect(shouldAutoSpeak(false)).toBe(false);
	});
});

describe("createSpeaker", () => {
	const spoken: string[] = [];
	let fetchMock: ReturnType<typeof vi.fn>;
	let played: string[];

	beforeEach(() => {
		spoken.length = 0;
		played = [];
		class FakeUtterance {
			lang = "";
			voice: unknown = null;
			onend: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor(public text: string) {}
		}
		vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
		vi.stubGlobal("speechSynthesis", {
			getVoices: () => [],
			cancel: vi.fn(),
			speak: (u: FakeUtterance) => {
				spoken.push(u.text);
				queueMicrotask(() => u.onend?.());
			},
		});
		vi.stubGlobal(
			"Audio",
			class {
				src = "";
				onended: (() => void) | null = null;
				onerror: (() => void) | null = null;
				pause() {}
				play() {
					played.push(this.src);
					return Promise.resolve();
				}
			},
		);
		fetchMock = vi.fn(async () => new Response(new Uint8Array([0x49, 0x44, 0x33]), { headers: { "content-type": "audio/mpeg" } }));
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("speaks English with the Worker's voice", async () => {
		const speaker = createSpeaker();
		await speaker.speak("Hello there. How are you?");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(String(url)).toContain("/api/voice/speak/guest");
		expect(JSON.parse(String((init as RequestInit).body))).toEqual({ text: "Hello there. How are you?" });
		expect(played).toHaveLength(1);
		expect(spoken).toHaveLength(0);
	});

	it("speaks Arabic with the browser's voice and never calls the Worker", async () => {
		const speaker = createSpeaker();
		const ended = vi.fn();
		await speaker.speak("مرحبا. كيف حالك؟", { onEnd: ended });
		await Promise.resolve();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(spoken.join(" ")).toContain("مرحبا");
		expect(ended).toHaveBeenCalledTimes(1);
	});

	it("falls back to the browser's voice when the Worker refuses", async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "limit" }), { status: 429 }));
		const speaker = createSpeaker();
		await speaker.speak("Hello there.");
		expect(spoken).toEqual(["Hello there."]);
	});

	it("reports the end exactly once when stopped", async () => {
		const speaker = createSpeaker();
		const ended = vi.fn();
		await speaker.speak("Hello there.", { onEnd: ended });
		speaker.stop();
		speaker.stop();
		expect(ended).toHaveBeenCalledTimes(1);
	});
});
