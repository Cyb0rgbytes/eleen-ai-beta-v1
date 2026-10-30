/**
 * Studio's routes: paid video generation for allow-listed users.
 *
 * These are separate from /api/image/generate on purpose. That route is free,
 * open to guests, and fired by the chat on the model's say-so; nothing here
 * can be reached from it, from MCP or from the agent surfaces.
 *
 * A job runs: allow-list, price check, spend reservation, credit hold, fal.
 * Polling the job moves it on: when fal finishes, the clip is copied to R2 and
 * the hold is settled, and any failure releases the credits. Polling drives
 * this until webhooks and the sweeper arrive, so a job nobody polls stays
 * held. That is acceptable only while the allow-list is the owner.
 */
import { Env } from "../types";
import { isUuid, validatePrompt, ValidationError, validationResponse } from "../lib/validate";
import { balance, hold, release, settle } from "../lib/credits";
import { parseCeiling, releaseSpend, reserveSpend, spendDay } from "../lib/spend";
import { FalError, FalJob, falStatus, falVideoUrl, submitFal } from "../media/fal";
import { MEDIA_FILE_PREFIX, signMediaUrl, verifyMediaUrl } from "../media/signed";
import { mediaModel, publicModels } from "../media/registry";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function reply(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const notFound = () => reply(404, { error: "Not found." });

/** Far above a 15 s clip. The clip is buffered, so this also protects the Worker. */
const MAX_CLIP_BYTES = 64 * 1024 * 1024;

/** STUDIO_USER_IDS, comma-separated. Empty or unset turns Studio off for everyone. */
function canUseStudio(env: Env, userId: string): boolean {
	return (env.STUDIO_USER_IDS ?? "")
		.split(",")
		.map((id) => id.trim())
		.includes(userId);
}

interface JobRow {
	id: string;
	user_id: string;
	model: string;
	status: "running" | "succeeded" | "failed";
	credits: number;
	cost_micros: number;
	spend_day: string;
	request_id: string | null;
	status_url: string | null;
	response_url: string | null;
	r2_key: string | null;
}

const getJob = (db: D1Database, id: string, userId: string) =>
	db.prepare("SELECT * FROM media_jobs WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<JobRow>();

async function jobView(env: Env, job: JobRow) {
	const videoUrl = job.status === "succeeded" ? await signMediaUrl(env, job.id) : null;
	return { id: job.id, model: job.model, status: job.status, credits: job.credits, videoUrl };
}

/**
 * End a job as failed and return what was held. The conditional UPDATE is what
 * makes this once only: two polls can't both refund. `spent` keeps the spend
 * reservation when fal may have run the job, as its cost may be real.
 */
async function failJob(env: Env, job: JobRow, spent: boolean): Promise<void> {
	const row = await env.DB.prepare("UPDATE media_jobs SET status = 'failed', finished_at = ?2 WHERE id = ?1 AND status = 'running' RETURNING id")
		.bind(job.id, Date.now())
		.first();
	if (!row) return;
	await release(env.DB, job.id);
	if (!spent) await releaseSpend(env.DB, job.cost_micros, job.spend_day);
}

/** Copy a finished clip into R2, then charge. The key is fixed, so a repeat overwrites the same bytes. */
async function completeJob(env: Env, job: JobRow, falJob: FalJob): Promise<void> {
	const source = new URL(await falVideoUrl(env, falJob));
	if (source.protocol !== "https:" || !source.hostname.endsWith(".fal.media")) throw new Error("Clip is not on fal's media host");

	const response = await fetch(source);
	if (!response.ok) throw new Error(`Clip download answered ${response.status}`);
	const bytes = await response.arrayBuffer();
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIP_BYTES) throw new Error("Clip size is out of range");

	const key = `u/${job.user_id}/${job.id}.mp4`;
	await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });

	const row = await env.DB.prepare("UPDATE media_jobs SET status = 'succeeded', r2_key = ?2, finished_at = ?3 WHERE id = ?1 AND status = 'running' RETURNING id")
		.bind(job.id, key, Date.now())
		.first();
	if (row) await settle(env.DB, job.id);
}

/** Bring a running job up to date with fal. Trouble reaching fal leaves it running for the next poll. */
async function advanceJob(env: Env, job: JobRow): Promise<JobRow> {
	if (job.status !== "running" || !job.request_id || !job.status_url || !job.response_url) return job;
	const falJob: FalJob = { requestId: job.request_id, statusUrl: job.status_url, responseUrl: job.response_url };
	try {
		const status = await falStatus(env, falJob);
		if (status.state !== "COMPLETED") return job;
		if (status.error) await failJob(env, job, true);
		else await completeJob(env, job, falJob);
	} catch (error) {
		console.error("Media job poll failed:", error instanceof Error ? error.message : "unknown");
		return job;
	}
	return (await getJob(env.DB, job.id, job.user_id)) ?? job;
}

/** What the Studio page needs to draw itself. A 404 for anyone not allow-listed. */
export async function handleStudio(_request: Request, env: Env, _ctx: ExecutionContext, userId: string): Promise<Response> {
	if (!canUseStudio(env, userId)) return notFound();
	return reply(200, { models: publicModels(), balance: await balance(env.DB, userId) });
}

export async function handleVideo(request: Request, env: Env, _ctx: ExecutionContext, userId: string): Promise<Response> {
	if (!canUseStudio(env, userId)) return notFound();

	let prompt: string;
	let body: Record<string, unknown>;
	try {
		body = ((await request.json()) ?? {}) as Record<string, unknown>;
		prompt = validatePrompt(body);
	} catch (error) {
		if (error instanceof ValidationError) return validationResponse(error);
		return reply(400, { error: "Invalid JSON." });
	}

	const model = mediaModel(body.model);
	if (!model) return reply(422, { error: "Unknown model.", reason: "unknown-model" });
	if (!isUuid(body.id)) return reply(422, { error: "A job id is required.", reason: "bad-id" });
	const id = body.id.toLowerCase();
	// Nothing is charged at a price the person didn't see.
	if (body.quotedCredits !== model.credits) return reply(409, { error: "The price has changed.", reason: "price-changed", credits: model.credits });

	const existing = await env.DB.prepare("SELECT * FROM media_jobs WHERE id = ?1").bind(id).first<JobRow>();
	if (existing) return existing.user_id === userId ? reply(200, await jobView(env, existing)) : notFound();

	const day = spendDay();
	if (!(await reserveSpend(env.DB, parseCeiling(env.STUDIO_DAILY_SPEND_MICROS), model.costMicros, day))) {
		return reply(503, { error: "Studio has reached its limit for today. Try again tomorrow.", reason: "spend-limit" });
	}

	const held = await hold(env.DB, userId, model.credits, id).catch(async (error) => {
		await releaseSpend(env.DB, model.costMicros, day);
		throw error;
	});
	if (!held.ok || held.replayed) {
		await releaseSpend(env.DB, model.costMicros, day);
		if (held.ok) return reply(409, { error: "This job has already started.", reason: "duplicate" });
		return reply(402, { error: "Not enough credits.", reason: "insufficient-credits" });
	}

	await env.DB.prepare(
		"INSERT INTO media_jobs (id, user_id, model, prompt, status, credits, cost_micros, spend_day, created_at) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7, ?8)",
	)
		.bind(id, userId, model.id, prompt, model.credits, model.costMicros, day, Date.now())
		.run();
	const job = (await getJob(env.DB, id, userId)) as JobRow;

	try {
		const submitted = await submitFal(env, model.endpoint, { prompt, ...model.input });
		await env.DB.prepare("UPDATE media_jobs SET request_id = ?2, status_url = ?3, response_url = ?4 WHERE id = ?1")
			.bind(id, submitted.requestId, submitted.statusUrl, submitted.responseUrl)
			.run();
	} catch (error) {
		console.error("Media submit failed:", error instanceof Error ? error.message : "unknown");
		// fal refused it, so nothing ran. Anything else is unclear: the job may
		// be running, so the customer is refunded but the cost stays reserved.
		const refused = error instanceof FalError && error.status !== null && error.status < 500;
		await failJob(env, job, !refused);
		if (error instanceof FalError && error.status === 403) {
			return reply(503, { error: "Studio is unavailable right now.", reason: "provider-locked" });
		}
		return reply(502, { error: "The video could not be started. Your credits were returned.", reason: "submit-failed" });
	}

	return reply(202, { id, model: model.id, status: "running", credits: model.credits, videoUrl: null });
}

export async function handleMediaJob(
	_request: Request,
	env: Env,
	_ctx: ExecutionContext,
	userId: string,
	[rawId]: readonly string[],
): Promise<Response> {
	if (!canUseStudio(env, userId) || !isUuid(rawId)) return notFound();
	const job = await getJob(env.DB, rawId.toLowerCase(), userId);
	if (!job) return notFound();
	return reply(200, await jobView(env, await advanceJob(env, job)));
}

/**
 * A generated clip, above the auth gate: the signed URL is the credential.
 * Range requests are what let the player seek.
 */
export async function handleMediaFile(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
	const id = url.pathname.slice(MEDIA_FILE_PREFIX.length).toLowerCase();
	if (!isUuid(id) || !(await verifyMediaUrl(env, id, url))) return new Response("Not found", { status: 404 });

	const job = await env.DB.prepare("SELECT r2_key FROM media_jobs WHERE id = ?1").bind(id).first<{ r2_key: string | null }>();
	if (!job?.r2_key) return new Response("Not found", { status: 404 });

	const object = await env.MEDIA.get(job.r2_key, { range: request.headers });
	if (!object) return new Response("Not found", { status: 404 });

	const headers = new Headers({ "accept-ranges": "bytes", "cache-control": "private, max-age=3600" });
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);

	const range = object.range as { offset?: number; length?: number } | undefined;
	if (range && request.headers.has("range")) {
		const start = range.offset ?? 0;
		const length = range.length ?? object.size - start;
		headers.set("content-range", `bytes ${start}-${start + length - 1}/${object.size}`);
		headers.set("content-length", String(length));
		return new Response(object.body, { status: 206, headers });
	}
	headers.set("content-length", String(object.size));
	return new Response(object.body, { headers });
}
