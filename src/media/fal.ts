/**
 * fal's queue API (https://fal.ai/docs/documentation/model-apis/inference/queue).
 *
 * Server side only: FAL_KEY is the owner's key, and every call here spends
 * the owner's money, so nothing reaches this module except the credit path.
 *
 * A submit is a new billable job, so a submit whose outcome is unclear is
 * never retried. The status and result URLs come from fal's response and are
 * checked against fal's origin before the key is sent to them.
 */
import { Env } from "../types";

const QUEUE_ORIGIN = "https://queue.fal.run";

export interface FalJob {
	requestId: string;
	statusUrl: string;
	responseUrl: string;
}

export type FalStatus =
	| { state: "IN_QUEUE" | "IN_PROGRESS" }
	| { state: "COMPLETED"; error: string | null };

export class FalError extends Error {
	constructor(
		message: string,
		/** The HTTP status, or null when the response itself was unusable. */
		readonly status: number | null,
	) {
		super(message);
	}
}

function headers(env: Env): Record<string, string> {
	// Fails before any provider call: there is no fallback credential.
	if (!env.FAL_KEY) throw new FalError("FAL_KEY is not set", null);
	return { Authorization: `Key ${env.FAL_KEY}`, "Content-Type": "application/json" };
}

/** A URL from a fal response, only if it is fal's own. The key is sent to it. */
function falUrl(value: unknown): string {
	if (typeof value === "string") {
		try {
			const url = new URL(value);
			if (url.origin === QUEUE_ORIGIN) return url.href;
		} catch {
			// Falls through to the refusal below.
		}
	}
	throw new FalError("fal returned a URL outside its origin", null);
}

async function json(response: Response): Promise<Record<string, unknown>> {
	// The body may echo the prompt, so only the status is reported.
	if (!response.ok) throw new FalError(`fal answered ${response.status}`, response.status);
	return (await response.json()) as Record<string, unknown>;
}

/**
 * Queue a job. Inputs differ by model, so they come from the media registry,
 * which fixes every option: a model's defaults can be its most expensive.
 * `webhookUrl` is where fal reports the outcome.
 */
export async function submitFal(env: Env, endpoint: string, input: Record<string, unknown>, webhookUrl?: string): Promise<FalJob> {
	const url = new URL(`${QUEUE_ORIGIN}/${endpoint}`);
	if (webhookUrl) url.searchParams.set("fal_webhook", webhookUrl);

	const response = await fetch(url, { method: "POST", headers: headers(env), body: JSON.stringify(input) });
	const body = await json(response);
	if (typeof body.request_id !== "string") throw new FalError("fal returned no request id", null);
	return {
		requestId: body.request_id,
		statusUrl: falUrl(body.status_url),
		responseUrl: falUrl(body.response_url),
	};
}

/** Where a job has got to. A job in the queue is not a result. */
export async function falStatus(env: Env, job: FalJob): Promise<FalStatus> {
	const body = await json(await fetch(falUrl(job.statusUrl), { headers: headers(env) }));
	if (body.status === "IN_QUEUE" || body.status === "IN_PROGRESS") return { state: body.status };
	if (body.status === "COMPLETED") {
		return { state: "COMPLETED", error: typeof body.error === "string" ? body.error : null };
	}
	throw new FalError("fal returned an unknown status", null);
}

/** The video of a completed job: a short-lived URL to copy into R2. */
export async function falVideoUrl(env: Env, job: FalJob): Promise<string> {
	const body = await json(await fetch(falUrl(job.responseUrl), { headers: headers(env) }));
	const video = body.video as { url?: unknown } | undefined;
	if (typeof video?.url !== "string") throw new FalError("fal returned no video", null);
	return video.url;
}
