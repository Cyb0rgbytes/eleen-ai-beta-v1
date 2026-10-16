import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeysDialog } from "./dialog";

// Test values shaped like provider keys. Not real keys.
const OPENAI_KEY = "sk-" + "t".repeat(40) + "WXYZ";
const ANTHROPIC_KEY = "sk-ant-" + "q".repeat(40) + "9876";

interface Call {
	method: string;
	body: Record<string, unknown> | null;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;
let consoleLines: string[];

beforeEach(() => {
	calls = [];
	consoleLines = [];
	handler = () => json(200, { keys: [] });
	vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
		const call = { method: init.method ?? "GET", body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
		calls.push(call);
		return handler(call);
	});
	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			consoleLines.push(args.map(String).join(" "));
		});
	}
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

function setup() {
	const changes: string[][] = [];
	const dialog = createKeysDialog({ onChange: (p) => changes.push([...p].sort()) });
	const row = (provider: string) => dialog.element.querySelector(`.key-row[data-provider="${provider}"]`) as HTMLElement;
	const parts = (provider: string) => {
		const r = row(provider);
		const [replace, remove] = [...r.querySelectorAll<HTMLButtonElement>(".key-actions button")];
		return {
			masked: r.querySelector(".key-masked") as HTMLElement,
			replace: replace as HTMLButtonElement,
			remove: remove as HTMLButtonElement,
			form: r.querySelector(".key-form") as HTMLFormElement,
			input: r.querySelector(".key-input") as HTMLInputElement,
			label: r.querySelector(".key-label") as HTMLLabelElement,
			error: r.querySelector(".key-error") as HTMLElement,
			status: r.querySelector(".key-status") as HTMLElement,
		};
	};
	const submit = (form: HTMLFormElement) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	return { dialog, changes, parts, submit };
}

/**
 * Nothing in the page, the console, or what was rendered holds the key.
 * Booleans only: a failing toContain would print the key in its message.
 */
function expectKeyGone(dialog: HTMLDialogElement, key: string) {
	expect(dialog.outerHTML.includes(key), "key in the dialog markup").toBe(false);
	expect([...dialog.querySelectorAll("input")].some((i) => i.value.includes(key)), "key in a field").toBe(false);
	expect((document.body.textContent ?? "").includes(key), "key in page text").toBe(false);
	expect(consoleLines.join("\n").includes(key), "key in the console").toBe(false);
}

describe("keys form", () => {
	it("lists the four providers with the stored key's last four", async () => {
		handler = () => json(200, { keys: [{ provider: "openai", last4: "WXYZ", createdAt: 1, verifiedAt: 1 }] });
		const { dialog, parts, changes } = setup();
		dialog.open();
		await vi.waitFor(() => expect(parts("openai").masked.textContent).toBe("Ends in WXYZ"));

		expect(dialog.element.querySelectorAll(".key-row")).toHaveLength(4);
		expect(parts("openai").replace.textContent).toBe("Replace");
		expect(parts("openai").remove.hidden).toBe(false);
		expect(parts("anthropic").masked.textContent).toBe("No key");
		expect(parts("anthropic").replace.textContent).toBe("Add");
		expect(parts("anthropic").remove.hidden).toBe(true);
		expect(changes.at(-1)).toEqual(["openai"]);
	});

	it("shows at most four characters of whatever the server sends, as text", async () => {
		handler = () => json(200, { keys: [{ provider: "google", last4: '<img src=x onerror="window.__xss=1">', createdAt: 1 }] });
		const { dialog, parts } = setup();
		dialog.open();
		await vi.waitFor(() => expect(parts("google").masked.textContent).toBe('Ends in =1">'));
		expect(dialog.element.querySelector("img")).toBeNull();
	});

	it("labels the field above it, with no placeholder standing in for a label", () => {
		const { dialog, parts } = setup();
		dialog.open();
		const { label, input } = parts("openai");
		expect(label.htmlFor).toBe(input.id);
		expect(label.textContent).toBe("OpenAI API key");
		expect(input.placeholder).toBe("");
		expect(input.type).toBe("password");
		expect(input.autocomplete).toBe("off");
	});

	it("saves a key, shows its last four, and clears the field before the request leaves", async () => {
		const { dialog, parts, submit, changes } = setup();
		dialog.open();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		const openai = parts("openai");
		let fieldDuringRequest = "unset";
		handler = (call) => {
			fieldDuringRequest = openai.input.value;
			expect(call.method).toBe("PUT");
			expect(call.body?.provider).toBe("openai");
			expect(call.body?.key === OPENAI_KEY, "the pasted key is the PUT body").toBe(true);
			return json(200, { provider: "openai", last4: "WXYZ", createdAt: 2, verifiedAt: 2, verified: true });
		};

		openai.replace.click();
		expect(openai.form.hidden).toBe(false);
		openai.input.value = OPENAI_KEY;
		submit(openai.form);

		await vi.waitFor(() => expect(openai.masked.textContent).toBe("Ends in WXYZ"));
		expect(fieldDuringRequest === "", "the field was empty while the request ran").toBe(true);
		expect(openai.form.hidden).toBe(true);
		expect(openai.status.textContent).toBe("Saved. The key ends in WXYZ.");
		expect(changes.at(-1)).toEqual(["openai"]);
		expectKeyGone(dialog.element, OPENAI_KEY);
	});

	it("says so when the provider could not be reached to check the key", async () => {
		const { dialog, parts, submit } = setup();
		dialog.open();
		handler = () => json(200, { provider: "openai", last4: "WXYZ", createdAt: 2, verifiedAt: null, verified: false });
		const openai = parts("openai");
		openai.replace.click();
		openai.input.value = OPENAI_KEY;
		submit(openai.form);
		await vi.waitFor(() => expect(openai.status.textContent).toContain("could not be reached"));
	});

	it("shows a provider's refusal inline, under the field, and keeps the key out of the page", async () => {
		const { dialog, parts, submit, changes } = setup();
		dialog.open();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		handler = () => json(422, { error: "anthropic rejected this key.", status: 401 });
		const anthropic = parts("anthropic");
		anthropic.replace.click();
		anthropic.input.value = ANTHROPIC_KEY;
		submit(anthropic.form);

		await vi.waitFor(() => expect(anthropic.error.hidden).toBe(false));
		expect(anthropic.error.textContent).toBe("Anthropic rejected this key.");
		expect(anthropic.input.getAttribute("aria-invalid")).toBe("true");
		expect(anthropic.input.getAttribute("aria-describedby")).toBe(anthropic.error.id);
		expect(anthropic.form.hidden).toBe(false);
		expect(changes.flat()).not.toContain("anthropic");
		expectKeyGone(dialog.element, ANTHROPIC_KEY);
	});

	it("tells a wrong-shaped key apart from a refused one", async () => {
		const { dialog, parts, submit } = setup();
		dialog.open();
		handler = () => json(422, { error: "That does not look like a openai API key." });
		const openai = parts("openai");
		openai.replace.click();
		openai.input.value = "not-a-key";
		submit(openai.form);
		await vi.waitFor(() => expect(openai.error.textContent).toBe("That does not look like a OpenAI API key."));
	});

	it("asks for a key before sending an empty one", () => {
		const { dialog, parts, submit } = setup();
		dialog.open();
		const before = calls.length;
		const openai = parts("openai");
		openai.replace.click();
		openai.input.value = "   ";
		submit(openai.form);
		expect(openai.error.textContent).toBe("Paste a key first.");
		expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
		expect(calls.length).toBe(before);
	});

	it("removes a key only after a second press", async () => {
		handler = () => json(200, { keys: [{ provider: "openai", last4: "WXYZ", createdAt: 1, verifiedAt: 1 }] });
		const { dialog, parts, changes } = setup();
		dialog.open();
		const openai = parts("openai");
		await vi.waitFor(() => expect(openai.remove.hidden).toBe(false));

		openai.remove.click();
		expect(openai.remove.textContent).toBe("Confirm removal");
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);

		handler = (call) => {
			expect(call).toEqual({ method: "DELETE", body: { provider: "openai" } });
			return json(200, { provider: "openai", removed: true });
		};
		openai.remove.click();
		await vi.waitFor(() => expect(openai.masked.textContent).toBe("No key"));
		expect(openai.remove.hidden).toBe(true);
		expect(changes.at(-1)).toEqual([]);
	});

	it("opens straight into the field for the provider a locked model needs", async () => {
		const { dialog, parts } = setup();
		dialog.open("anthropic");
		const anthropic = parts("anthropic");
		expect(anthropic.form.hidden).toBe(false);
		expect(document.activeElement).toBe(anthropic.input);
	});

	it("drops a half-typed key when the dialog closes", () => {
		const { dialog, parts } = setup();
		dialog.open();
		const openai = parts("openai");
		openai.replace.click();
		openai.input.value = OPENAI_KEY;
		dialog.close();
		expect(openai.input.value === "", "the field was cleared").toBe(true);
		expect(openai.form.hidden).toBe(true);
	});

	it("forgets every key on sign-out", async () => {
		handler = () => json(200, { keys: [{ provider: "openai", last4: "WXYZ", createdAt: 1, verifiedAt: 1 }] });
		const { dialog, parts, changes } = setup();
		await dialog.refresh();
		expect(parts("openai").masked.textContent).toBe("Ends in WXYZ");
		dialog.reset();
		expect(parts("openai").masked.textContent).toBe("No key");
		expect(changes.at(-1)).toEqual([]);
	});
});
