/** The fal queue client against a fake fetch. No test reaches fal: every real call costs money. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FalError, FalJob, falStatus, falVideoUrl, submitFal } from "../src/media/fal";
import type { Env } from "../src/types";

const MINIMAX_H3 = "minimax/h3/text-to-video";
const KEY = "test-key-not-real";
const env = { FAL_KEY: KEY } as Env;
const input = { prompt: "A kitten", duration: 5, resolution: "480P" } as const;

const job: FalJob = {
	requestId: "req-1",
	statusUrl: "https://queue.fal.run/minimax/h3/requests/req-1/status",
	responseUrl: "https://queue.fal.run/minimax/h3/requests/req-1",
};

const accepted = {
	request_id: "req-1",
	status_url: job.statusUrl,
	response_url: job.responseUrl,
};

function fakeFetch(body: unknown, status = 200) {
	const fetch = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("submitFal", () => {
	it("queues the job with the key in a header, and the input in the body", async () => {
		const fetch = fakeFetch(accepted);
		expect(await submitFal(env, MINIMAX_H3, input)).toEqual(job);

		const [url, init] = fetch.mock.calls[0];
		expect(String(url)).toBe("https://queue.fal.run/minimax/h3/text-to-video");
		expect((init?.headers as Record<string, string>).Authorization).toBe(`Key ${KEY}`);
		expect(JSON.parse(init?.body as string)).toEqual(input);
	});

	it("passes the webhook as fal_webhook, and never the key in the URL", async () => {
		const fetch = fakeFetch(accepted);
		await submitFal(env, MINIMAX_H3, input, "https://eleenai.xyz/api/hooks/fal/job-1");
		const url = new URL(String(fetch.mock.calls[0][0]));
		expect(url.searchParams.get("fal_webhook")).toBe("https://eleenai.xyz/api/hooks/fal/job-1");
		expect(url.href).not.toContain(KEY);
	});

	it("makes no request without a key", async () => {
		const fetch = fakeFetch(accepted);
		await expect(submitFal({} as Env, MINIMAX_H3, input)).rejects.toThrow(FalError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("submits once when the answer is an error: a retry would be a second billable job", async () => {
		const fetch = fakeFetch({ detail: "A kitten" }, 500);
		const error = await submitFal(env, MINIMAX_H3, input).catch((e) => e);
		expect(error).toBeInstanceOf(FalError);
		expect(error.status).toBe(500);
		expect(error.message).not.toContain("kitten");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("reports an exhausted balance by its status, without retrying", async () => {
		const fetch = fakeFetch({ detail: "User is locked. Reason: Exhausted balance." }, 403);
		await expect(submitFal(env, MINIMAX_H3, input)).rejects.toMatchObject({ status: 403 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("refuses status and result URLs outside fal's origin", async () => {
		for (const url of ["https://evil.example/x", "http://queue.fal.run/x", "https://queue.fal.run.evil.example/x", "not a url", 7]) {
			fakeFetch({ ...accepted, status_url: url });
			await expect(submitFal(env, MINIMAX_H3, input)).rejects.toThrow(/origin/);
		}
	});
});

describe("falStatus", () => {
	it("reports a job still running", async () => {
		fakeFetch({ status: "IN_QUEUE", queue_position: 2 });
		expect(await falStatus(env, job)).toEqual({ state: "IN_QUEUE" });
	});

	it("separates a success from a failure, which also ends as COMPLETED", async () => {
		fakeFetch({ status: "COMPLETED" });
		expect(await falStatus(env, job)).toEqual({ state: "COMPLETED", error: null });
		fakeFetch({ status: "COMPLETED", error: "Internal error" });
		expect(await falStatus(env, job)).toEqual({ state: "COMPLETED", error: "Internal error" });
	});

	it("will not send the key to a stored URL that isn't fal's", async () => {
		const fetch = fakeFetch({ status: "IN_QUEUE" });
		await expect(falStatus(env, { ...job, statusUrl: "https://evil.example/status" })).rejects.toThrow(/origin/);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("falVideoUrl", () => {
	it("returns the video URL", async () => {
		fakeFetch({ video: { url: "https://v3b.fal.media/files/b/x.mp4", content_type: "video/mp4" } });
		expect(await falVideoUrl(env, job)).toBe("https://v3b.fal.media/files/b/x.mp4");
	});

	it("refuses a result with no video", async () => {
		fakeFetch({ video: null });
		await expect(falVideoUrl(env, job)).rejects.toThrow(/no video/);
	});
});
