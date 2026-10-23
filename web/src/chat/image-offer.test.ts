/**
 * S2 (audit item 5): an [IMG_GEN] in a reply runs at once only on an
 * ordinary turn. When the server marks the turn contained (it carried a file
 * or was hardened as a likely injection), the reply offers a button instead,
 * and nothing is generated until it is clicked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../../../src/shared/stream";

vi.mock("../history/api", () => ({ getConversation: vi.fn(), patchConversation: vi.fn() }));
vi.mock("../auth/clerk", () => ({ isSignedIn: () => true, openSignIn: vi.fn() }));

const api = vi.hoisted(() => ({ events: [] as StreamEvent[], request: vi.fn() }));
vi.mock("../api/client", async (original) => {
	const real = await original<typeof import("../api/client")>();
	return {
		...real,
		request: api.request,
		streamChat: async function* () {
			for (const event of api.events) yield event;
		},
	};
});

const { createChat } = await import("./controller");
const { resetHistoryState, setHistoryState } = await import("../history/state");

const REPLY = "Here is your summary. [IMG_GEN]a photo of the front door[/IMG_GEN]";

function events(meta: Record<string, unknown>): StreamEvent[] {
	return [
		{ type: "meta", data: { protocol: 2, model: "fast", ...meta } },
		{ type: "token", data: { text: REPLY } },
		{ type: "done", data: {} },
	];
}

describe("[IMG_GEN] on a contained turn", () => {
	let container: HTMLElement;

	beforeEach(() => {
		resetHistoryState();
		// Unsaved: the reply is only on the page.
		setHistoryState({ signedIn: true, historyOn: false });
		container = document.createElement("div");
		document.body.append(container);
		api.request.mockReset();
		api.request.mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" })));
		if (!URL.createObjectURL) URL.createObjectURL = () => "blob:test";
	});

	afterEach(() => container.remove());

	function chat() {
		return createChat({
			messages: container,
			onBusyChange: () => {},
			emptyState: () => document.createElement("div"),
			labelFor: () => null,
		});
	}

	const generated = () => api.request.mock.calls.filter(([path]) => String(path).startsWith("/api/image/generate"));

	it("runs at once on an ordinary turn", async () => {
		api.events = events({});
		await chat().sendMessage("Draw my door");
		expect(generated()).toHaveLength(1);
		expect(container.querySelector(".image-offer")).toBeNull();
	});

	it("offers a button instead when the server marked the turn contained, and runs only on a click", async () => {
		api.events = events({ contained: true });
		const c = chat();
		await c.sendMessage("Summarise the attached file");
		expect(generated()).toHaveLength(0);

		const button = container.querySelector<HTMLButtonElement>(".assistant-message .image-offer, .image-offer");
		expect(button).not.toBeNull();
		expect(button!.textContent).toBe("Generate image?");
		expect(button!.title).toContain("a photo of the front door");

		button!.click();
		expect(generated()).toHaveLength(1);
		expect(generated()[0]![1]).toMatchObject({ body: { prompt: "a photo of the front door" } });
		// One click, one image: the button is gone.
		expect(container.querySelector(".image-offer")).toBeNull();
	});
});
