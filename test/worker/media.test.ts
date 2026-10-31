/**
 * Studio's routes against real D1 and R2, with fal faked. No test reaches fal:
 * every real call costs money.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker, { PURGE_CRON, SWEEP_CRON } from "../../src/index";
import { handleMediaFile, handleMediaJob, handleStudio, handleVideo, sweepMediaJobs } from "../../src/api/media";
import { addCredits, balance, holdState } from "../../src/lib/credits";
import { MEDIA_MODELS, publicModels } from "../../src/media/registry";
import { signMediaUrl } from "../../src/media/signed";
import type { Env } from "../../src/types";
import { ORIGIN, send } from "./helpers";

const QUEUE = "https://queue.fal.run/minimax/h3-max-turbo/requests/req-1";
const CLIP = "https://v3b.fal.media/files/b/clip.mp4";
const model = MEDIA_MODELS[0];
const ctx = {} as ExecutionContext;

let counter = 0;
const unique = (label: string) => `${label}-${++counter}`;
const day = () => `2026-test-${++counter}`;

function studioEnv(userId: string, extra: Partial<Env> = {}): Env {
	return {
		...(env as unknown as Env),
		AI: { run: async () => ({ response: "ALLOW" }) } as unknown as Ai,
		FAL_KEY: "test-key-not-real",
		MEDIA_URL_KEY: "test-signing-key",
		STUDIO_USER_IDS: `someone-else, ${userId}`,
		STUDIO_DAILY_SPEND_MICROS: "10000000",
		...extra,
	};
}

async function funded(credits = 1000): Promise<string> {
	const userId = unique("user");
	await addCredits(env.DB, userId, "grant", credits, unique("grant"), null);
	return userId;
}

interface FakeFal {
	submit?: Response;
	status?: unknown;
	result?: unknown;
	clip?: Response;
}

function fakeFal(fake: FakeFal = {}) {
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `${QUEUE}/status`) return json(fake.status ?? { status: "IN_PROGRESS" });
		if (url === QUEUE) return json(fake.result ?? { video: { url: CLIP } });
		if (url === CLIP) return fake.clip ?? new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
		if (url.startsWith("https://queue.fal.run/")) {
			return fake.submit ?? json({ request_id: "req-1", status_url: `${QUEUE}/status`, response_url: QUEUE });
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

const submits = (fetchMock: ReturnType<typeof fakeFal>) =>
	fetchMock.mock.calls.filter(([url]) => String(url).includes("/text-to-video")).length;

function videoRequest(body: Record<string, unknown>) {
	return new Request(`${ORIGIN}/api/media/video`, { method: "POST", body: JSON.stringify(body) });
}

const job = (overrides: Record<string, unknown> = {}) => ({
	id: crypto.randomUUID(),
	prompt: "A kitten",
	model: model.id,
	quotedCredits: model.credits,
	...overrides,
});

const poll = (testEnv: Env, userId: string, id: string) =>
	handleMediaJob(new Request(`${ORIGIN}/api/media/jobs/${id}`), testEnv, ctx, userId, [id]);

const spent = async (spendDay: string) =>
	(await env.DB.prepare("SELECT micros FROM studio_spend WHERE day = ?1").bind(spendDay).first<{ micros: number }>())?.micros ?? 0;

async function started(userId: string, testEnv = studioEnv(userId)) {
	const body = job();
	const response = await handleVideo(videoRequest(body), testEnv, ctx, userId);
	expect(response.status).toBe(202);
	return { id: body.id, testEnv };
}

const jobDay = async (id: string) =>
	(await env.DB.prepare("SELECT spend_day FROM media_jobs WHERE id = ?1").bind(id).first<{ spend_day: string }>())?.spend_day ?? day();

afterEach(() => vi.unstubAllGlobals());

describe("who can reach Studio", () => {
	it("is signed-in only, through the real router", async () => {
		fakeFal();
		for (const path of ["/api/media/studio", `/api/media/jobs/${crypto.randomUUID()}`]) {
			expect((await send(path, null)).response.status).toBe(401);
		}
		expect((await send("/api/media/video", null, { method: "POST", body: "{}" })).response.status).toBe(401);
	});

	it("is a 404 for a signed-in user who isn't allow-listed", async () => {
		const fetchMock = fakeFal();
		const userId = await funded();
		const testEnv = studioEnv("someone-else");
		expect((await handleStudio(new Request(ORIGIN), testEnv, ctx, userId)).status).toBe(404);
		expect((await handleVideo(videoRequest(job()), testEnv, ctx, userId)).status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await balance(env.DB, userId)).toBe(1000);
	});

	it("is off for everyone when the allow-list is empty", async () => {
		const userId = await funded();
		const testEnv = studioEnv(userId, { STUDIO_USER_IDS: "" });
		expect((await handleStudio(new Request(ORIGIN), testEnv, ctx, userId)).status).toBe(404);
	});

	it("shows models and balance, and never the cost", async () => {
		const userId = await funded();
		const response = await handleStudio(new Request(ORIGIN), studioEnv(userId), ctx, userId);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({ models: publicModels(), balance: 1000 });
		expect(body).not.toContain("cost");
	});
});

describe("starting a video", () => {
	it("holds the credits and sends only the registry's options", async () => {
		const fetchMock = fakeFal();
		const userId = await funded();
		await started(userId);
		expect(await balance(env.DB, userId)).toBe(1000 - model.credits);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ prompt: "A kitten", ...model.input });
	});

	it("ignores anything else the client sends", async () => {
		const fetchMock = fakeFal();
		const userId = await funded();
		await handleVideo(videoRequest(job({ resolution: "4K", duration: 15, target_audio_url: "https://evil.example" })), studioEnv(userId), ctx, userId);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.body).not.toContain("4K");
		expect(init.body).not.toContain("evil");
	});

	it("refuses an unknown model, a stale price and a bad id before anything moves", async () => {
		const fetchMock = fakeFal();
		const userId = await funded();
		const testEnv = studioEnv(userId);
		expect((await handleVideo(videoRequest(job({ model: "minimax/h3/text-to-video" })), testEnv, ctx, userId)).status).toBe(422);
		expect((await handleVideo(videoRequest(job({ quotedCredits: 1 })), testEnv, ctx, userId)).status).toBe(409);
		expect((await handleVideo(videoRequest(job({ id: "nope" })), testEnv, ctx, userId)).status).toBe(422);
		expect((await handleVideo(videoRequest(job({ prompt: "" })), testEnv, ctx, userId)).status).toBe(422);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await balance(env.DB, userId)).toBe(1000);
	});

	it("starts one job for a repeated id", async () => {
		const fetchMock = fakeFal();
		const userId = await funded();
		const testEnv = studioEnv(userId);
		const body = job();
		await handleVideo(videoRequest(body), testEnv, ctx, userId);
		const again = await handleVideo(videoRequest(body), testEnv, ctx, userId);
		expect(again.status).toBe(200);
		expect(submits(fetchMock)).toBe(1);
		expect(await balance(env.DB, userId)).toBe(1000 - model.credits);
	});

	it("does not show another user's job for a guessed id", async () => {
		fakeFal();
		const owner = await funded();
		const body = job();
		await handleVideo(videoRequest(body), studioEnv(owner), ctx, owner);
		const other = await funded();
		expect((await handleVideo(videoRequest(body), studioEnv(other), ctx, other)).status).toBe(404);
		expect((await poll(studioEnv(other), other, body.id)).status).toBe(404);
	});

	it("refuses without enough credits, and gives the spend back", async () => {
		const fetchMock = fakeFal();
		const userId = await funded(model.credits - 1);
		const response = await handleVideo(videoRequest(job()), studioEnv(userId), ctx, userId);
		expect(response.status).toBe(402);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stops at the daily ceiling, and with no ceiling at all", async () => {
		const fetchMock = fakeFal();
		const userId = await funded();
		const low = studioEnv(userId, { STUDIO_DAILY_SPEND_MICROS: "1" });
		const none = studioEnv(userId, { STUDIO_DAILY_SPEND_MICROS: undefined });
		for (const testEnv of [low, none]) {
			const response = await handleVideo(videoRequest(job()), testEnv, ctx, userId);
			expect(response.status).toBe(503);
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await balance(env.DB, userId)).toBe(1000);
	});

	it("refunds and gives the spend back when fal refuses the job", async () => {
		const fetchMock = fakeFal({ submit: new Response("{}", { status: 422 }) });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const userId = await funded();
		const body = job();
		const before = await spent(new Date().toISOString().slice(0, 10));
		expect((await handleVideo(videoRequest(body), studioEnv(userId), ctx, userId)).status).toBe(502);
		expect(await balance(env.DB, userId)).toBe(1000);
		expect(await holdState(env.DB, body.id)).toBe("released");
		expect(await spent(await jobDay(body.id))).toBe(before);
		expect(submits(fetchMock)).toBe(1);
		vi.restoreAllMocks();
	});

	it("refunds but keeps the spend reserved when the outcome is unclear, and never resubmits", async () => {
		const fetchMock = fakeFal({ submit: new Response("{}", { status: 500 }) });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const userId = await funded();
		const body = job();
		const before = await spent(new Date().toISOString().slice(0, 10));
		await handleVideo(videoRequest(body), studioEnv(userId), ctx, userId);
		expect(await balance(env.DB, userId)).toBe(1000);
		expect(await spent(await jobDay(body.id))).toBe(before + model.costMicros);
		expect(submits(fetchMock)).toBe(1);
		vi.restoreAllMocks();
	});

	it("keeps fal's lock reason out of the response", async () => {
		fakeFal({ submit: new Response(JSON.stringify({ detail: "Exhausted balance" }), { status: 403 }) });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const userId = await funded();
		const response = await handleVideo(videoRequest(job()), studioEnv(userId), ctx, userId);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("balance");
		expect(await balance(env.DB, userId)).toBe(1000);
		vi.restoreAllMocks();
	});
});

describe("polling a job", () => {
	it("stays running while fal works", async () => {
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		const body = (await (await poll(testEnv, userId, id)).json()) as { status: string; videoUrl: string | null };
		expect(body).toMatchObject({ status: "running", videoUrl: null });
		expect(await holdState(env.DB, id)).toBe("open");
	});

	it("copies the clip to R2, charges once, and gives a playable URL", async () => {
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		fakeFal({ status: { status: "COMPLETED" } });

		const body = (await (await poll(testEnv, userId, id)).json()) as { status: string; videoUrl: string };
		expect(body.status).toBe("succeeded");
		expect(await holdState(env.DB, id)).toBe("charged");
		expect(await balance(env.DB, userId)).toBe(1000 - model.credits);

		const file = await handleMediaFile(new Request(`${ORIGIN}${body.videoUrl}`), testEnv, new URL(`${ORIGIN}${body.videoUrl}`));
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("video/mp4");
		expect(new Uint8Array(await file.arrayBuffer())).toHaveLength(8);

		await poll(testEnv, userId, id);
		expect(await balance(env.DB, userId)).toBe(1000 - model.credits);
	});

	it("refunds a job fal reports as failed, once, keeping the spend", async () => {
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		fakeFal({ status: { status: "COMPLETED", error: "Internal error" } });
		const body = (await (await poll(testEnv, userId, id)).json()) as { status: string };
		expect(body.status).toBe("failed");
		await poll(testEnv, userId, id);
		expect(await balance(env.DB, userId)).toBe(1000);
		expect(await holdState(env.DB, id)).toBe("released");
	});

	it("leaves a job running when fal can't be reached, charging nothing", async () => {
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const body = (await (await poll(testEnv, userId, id)).json()) as { status: string };
		expect(body.status).toBe("running");
		expect(await holdState(env.DB, id)).toBe("open");
		vi.restoreAllMocks();
	});

	it("refuses a clip that isn't on fal's media host", async () => {
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		fakeFal({ status: { status: "COMPLETED" }, result: { video: { url: "https://evil.example/clip.mp4" } } });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const body = (await (await poll(testEnv, userId, id)).json()) as { status: string };
		expect(body.status).toBe("running");
		expect(await holdState(env.DB, id)).toBe("open");
		vi.restoreAllMocks();
	});
});

describe("sweeping jobs nobody is watching", () => {
	const MINUTE = 60 * 1000;
	const age = (id: string, ms: number) =>
		env.DB.prepare("UPDATE media_jobs SET created_at = ?2 WHERE id = ?1").bind(id, Date.now() - ms).run();

	/** Other tests leave running jobs behind; this file's sweeps must not trip on them. */
	const clearRunning = () => env.DB.prepare("UPDATE media_jobs SET status = 'failed' WHERE status = 'running'").run();

	const jobStatus = async (id: string) =>
		(await env.DB.prepare("SELECT status FROM media_jobs WHERE id = ?1").bind(id).first<{ status: string }>())?.status;

	it("finishes a closed page's job: stores the clip and charges once", async () => {
		await clearRunning();
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		await age(id, 3 * MINUTE);
		fakeFal({ status: { status: "COMPLETED" } });

		expect(await sweepMediaJobs(testEnv)).toBe(1);
		expect(await jobStatus(id)).toBe("succeeded");
		expect(await holdState(env.DB, id)).toBe("charged");
		expect(await balance(env.DB, userId)).toBe(1000 - model.credits);
		expect(await sweepMediaJobs(testEnv)).toBe(0);
	});

	it("refunds a job fal reports as failed, keeping the cost reserved", async () => {
		await clearRunning();
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		await age(id, 3 * MINUTE);
		const reserved = await spent(await jobDay(id));
		fakeFal({ status: { status: "COMPLETED", error: "Internal error" } });

		await sweepMediaJobs(testEnv);
		expect(await jobStatus(id)).toBe("failed");
		expect(await balance(env.DB, userId)).toBe(1000);
		expect(await spent(await jobDay(id))).toBe(reserved);
	});

	it("leaves a recent job to its page", async () => {
		await clearRunning();
		const fetchMock = fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		fetchMock.mockClear();
		expect(await sweepMediaJobs(testEnv)).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await jobStatus(id)).toBe("running");
	});

	it("keeps a job that is still working, or when fal can't be reached, inside the age limit", async () => {
		await clearRunning();
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		await age(id, 30 * MINUTE);

		await sweepMediaJobs(testEnv);
		expect(await jobStatus(id)).toBe("running");

		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
		vi.spyOn(console, "error").mockImplementation(() => {});
		await sweepMediaJobs(testEnv);
		expect(await jobStatus(id)).toBe("running");
		expect(await holdState(env.DB, id)).toBe("open");
		vi.restoreAllMocks();
	});

	it("refunds a job past the age limit, once, and doesn't charge if it then succeeds", async () => {
		await clearRunning();
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		await age(id, 61 * MINUTE);

		await sweepMediaJobs(testEnv);
		expect(await jobStatus(id)).toBe("failed");
		expect(await holdState(env.DB, id)).toBe("released");

		fakeFal({ status: { status: "COMPLETED" } });
		await sweepMediaJobs(testEnv);
		await poll(testEnv, userId, id);
		expect(await balance(env.DB, userId)).toBe(1000);
		expect(await holdState(env.DB, id)).toBe("released");
	});

	it("refunds a job whose submit never finished, past the age limit", async () => {
		await clearRunning();
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		await env.DB.prepare("UPDATE media_jobs SET request_id = NULL WHERE id = ?1").bind(id).run();
		await age(id, 61 * MINUTE);
		await sweepMediaJobs(testEnv);
		expect(await balance(env.DB, userId)).toBe(1000);
	});

	it("carries on after one job fails", async () => {
		await clearRunning();
		fakeFal();
		const userId = await funded();
		const first = await started(userId);
		const second = await started(userId);
		await age(first.id, 5 * MINUTE);
		await age(second.id, 4 * MINUTE);
		await env.DB.prepare("UPDATE media_jobs SET status_url = 'https://evil.example/status' WHERE id = ?1").bind(first.id).run();
		fakeFal({ status: { status: "COMPLETED" } });
		vi.spyOn(console, "error").mockImplementation(() => {});

		await sweepMediaJobs(first.testEnv);
		expect(await jobStatus(first.id)).toBe("running");
		expect(await jobStatus(second.id)).toBe("succeeded");
		vi.restoreAllMocks();
	});
});

describe("the scheduled handler", () => {
	const scheduledWith = async (cron: string, testEnv: Env) => {
		const ctx = createExecutionContext();
		await worker.scheduled({ cron, scheduledTime: Date.now(), type: "scheduled", noRetry() {} } as ScheduledController, testEnv, ctx);
		await waitOnExecutionContext(ctx);
	};

	async function expiredConversation(): Promise<string> {
		const user = unique("user");
		const id = crypto.randomUUID();
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO users (user_id, created_at, last_seen_at) VALUES (?1, ?2, ?2)").bind(user, now),
			env.DB.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at, deleted_at) VALUES (?1, ?2, 'x', ?3, ?3, ?3)").bind(id, user, now - 40 * 24 * 60 * 60 * 1000),
		]);
		return id;
	}

	const conversationExists = async (id: string) =>
		(await env.DB.prepare("SELECT id FROM conversations WHERE id = ?1").bind(id).first()) !== null;

	const jobStatus = async (id: string) =>
		(await env.DB.prepare("SELECT status FROM media_jobs WHERE id = ?1").bind(id).first<{ status: string }>())?.status;

	it("the 5-minute trigger sweeps jobs and does not purge", async () => {
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		await env.DB.prepare("UPDATE media_jobs SET created_at = ?2 WHERE id = ?1").bind(id, Date.now() - 180_000).run();
		const conversation = await expiredConversation();
		fakeFal({ status: { status: "COMPLETED" } });

		await scheduledWith(SWEEP_CRON, testEnv);
		expect(await jobStatus(id)).toBe("succeeded");
		expect(await conversationExists(conversation)).toBe(true);
	});

	it("the daily trigger purges and does not sweep", async () => {
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		await env.DB.prepare("UPDATE media_jobs SET created_at = ?2 WHERE id = ?1").bind(id, Date.now() - 180_000).run();
		const conversation = await expiredConversation();
		const fetchMock = fakeFal({ status: { status: "COMPLETED" } });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await scheduledWith(PURGE_CRON, testEnv);
		expect(await conversationExists(conversation)).toBe(false);
		expect(await jobStatus(id)).toBe("running");
		expect(fetchMock).not.toHaveBeenCalled();
		log.mockRestore();
	});

	it("does nothing for a trigger it doesn't know", async () => {
		const conversation = await expiredConversation();
		await scheduledWith("0 0 * * *", env as unknown as Env);
		expect(await conversationExists(conversation)).toBe(true);
	});
});

describe("serving a clip", () => {
	async function finished() {
		fakeFal();
		const userId = await funded();
		const { id, testEnv } = await started(userId);
		fakeFal({ status: { status: "COMPLETED" } });
		const body = (await (await poll(testEnv, userId, id)).json()) as { videoUrl: string };
		return { id, testEnv, path: body.videoUrl };
	}

	it("serves a byte range so the player can seek", async () => {
		const { testEnv, path } = await finished();
		const request = new Request(`${ORIGIN}${path}`, { headers: { range: "bytes=2-4" } });
		const file = await handleMediaFile(request, testEnv, new URL(request.url));
		expect(file.status).toBe(206);
		expect(file.headers.get("content-range")).toBe("bytes 2-4/8");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([3, 4, 5]));
	});

	it("refuses a tampered, expired, unsigned or differently keyed URL", async () => {
		const { id, testEnv, path } = await finished();
		const tampered = `${path.slice(0, -1)}${path.endsWith("0") ? "1" : "0"}`;
		const expired = await signMediaUrl(testEnv, id, 1000);
		const unsigned = `/api/media/file/${id}`;
		for (const candidate of [tampered, expired as string, unsigned]) {
			const url = new URL(`${ORIGIN}${candidate}`);
			expect((await handleMediaFile(new Request(url), testEnv, url)).status).toBe(404);
		}
		const url = new URL(`${ORIGIN}${path}`);
		expect((await handleMediaFile(new Request(url), { ...testEnv, MEDIA_URL_KEY: "other" }, url)).status).toBe(404);
		expect((await handleMediaFile(new Request(url), { ...testEnv, MEDIA_URL_KEY: undefined }, url)).status).toBe(404);
	});

	it("is reached signed out through the real router", async () => {
		const { response } = await send(`/api/media/file/${crypto.randomUUID()}`, null);
		expect(response.status).toBe(404);
	});
});
