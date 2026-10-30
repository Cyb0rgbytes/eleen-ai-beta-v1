import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStudio, renderStudio, renderTeaser } from "./view";

const state = {
	balance: 1000,
	models: [
		{ id: "h3-max-turbo", label: "H3 Max Turbo", credits: 55 },
		{ id: "h3-max", label: "H3 Max", credits: 110 },
	],
};

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
	const mock = vi.fn(async (url: URL | string, init?: RequestInit) => handler(String(url), init));
	vi.stubGlobal("fetch", mock);
	return mock;
}

let root: HTMLElement;

beforeEach(() => {
	root = document.createElement("div");
	document.body.append(root);
	localStorage.clear();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
	root.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function submit(prompt = "A kitten") {
	(root.querySelector("textarea") as HTMLTextAreaElement).value = prompt;
	root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
	await vi.waitFor(() => expect((root.querySelector(".studio-status") as HTMLElement).textContent).not.toBe("Starting your video..."));
}

describe("the teaser", () => {
	it("says coming soon, with nothing to buy and no generator", () => {
		renderTeaser(root);
		expect(root.textContent).toContain("Coming soon");
		expect(root.querySelector("form")).toBeNull();
		expect(root.textContent).not.toMatch(/credit|price|\$|buy/i);
	});
});

describe("loadStudio", () => {
	it("treats a 404 and a signed-out answer as the teaser", async () => {
		stubFetch(() => json({}, 404));
		expect(await loadStudio()).toBeNull();
		stubFetch(() => json({}, 401));
		expect(await loadStudio()).toBeNull();
	});

	it("returns the models for an allowed account", async () => {
		stubFetch(() => json(state));
		expect(await loadStudio()).toEqual(state);
	});
});

describe("the generator", () => {
	it("shows the balance and each model's price", () => {
		renderStudio(root, state);
		expect(root.textContent).toContain("1000");
		const options = [...root.querySelectorAll("option")].map((o) => o.textContent);
		expect(options).toEqual(["H3 Max Turbo: 55 credits", "H3 Max: 110 credits"]);
	});

	it("sends the price it showed, and a job id", async () => {
		const mock = stubFetch(() => json({ id: "x", status: "running" }, 202));
		renderStudio(root, state);
		await submit();
		const [url, init] = mock.mock.calls[0]!;
		expect(String(url)).toContain("/api/media/video");
		const body = JSON.parse(init?.body as string);
		expect(body).toMatchObject({ prompt: "A kitten", model: "h3-max-turbo", quotedCredits: 55 });
		expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("refuses a second click while a job runs", async () => {
		const mock = stubFetch(() => json({ id: "x", status: "running" }, 202));
		renderStudio(root, state);
		await submit();
		expect((root.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
		root.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
		expect(mock).toHaveBeenCalledTimes(1);
	});

	it("shows the server's reason when a job can't start, and allows another try", async () => {
		stubFetch(() => json({ error: "Not enough credits." }, 402));
		renderStudio(root, state);
		await submit();
		expect(root.textContent).toContain("Not enough credits.");
		expect((root.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
	});

	it("plays the clip when the job finishes", async () => {
		stubFetch((url) => {
			if (url.includes("/api/media/jobs/")) return json({ status: "succeeded", videoUrl: "/api/media/file/x?sig=y" });
			if (url.includes("/api/media/studio")) return json({ ...state, balance: 945 });
			return json({ id: "x", status: "running" }, 202);
		});
		renderStudio(root, state);
		await submit();
		await vi.advanceTimersByTimeAsync(8000);
		await vi.waitFor(() => expect((root.querySelector("video") as HTMLVideoElement).hidden).toBe(false));
		expect((root.querySelector("video") as HTMLVideoElement).getAttribute("src")).toContain("/api/media/file/x");
		await vi.waitFor(() => expect(root.textContent).toContain("945"));
		expect(localStorage.length).toBe(0);
	});

	it("picks a job back up after a reload", async () => {
		localStorage.setItem("eleenai.studio.job", "job-1");
		const mock = stubFetch(() => json({ status: "running" }));
		renderStudio(root, state);
		await vi.advanceTimersByTimeAsync(8000);
		expect(String(mock.mock.calls[0]![0])).toContain("/api/media/jobs/job-1");
	});

	it("puts server text in as text, not markup", async () => {
		stubFetch(() => json({ error: "<img src=x onerror=alert(1)>" }, 500));
		renderStudio(root, state);
		await submit();
		expect(root.querySelector("img")).toBeNull();
	});
});
