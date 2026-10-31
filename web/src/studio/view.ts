/**
 * The Studio page's two states: "Coming soon" for everyone, and the generator
 * for allow-listed accounts. The server decides which: a 404 from
 * /api/media/studio is the teaser, so nothing here can open Studio to anyone.
 *
 * A price is only ever sent back as it was shown, so the server can refuse to
 * charge one the person didn't see. Text from the server goes in with
 * textContent, never as markup.
 */
import { ApiError, request } from "../api/client";
import { t } from "../i18n";

export interface StudioModel {
	id: string;
	label: string;
	credits: number;
}

export interface StudioState {
	models: StudioModel[];
	balance: number;
}

interface Job {
	id: string;
	status: "running" | "succeeded" | "failed";
	videoUrl: string | null;
}

const POLL_MS = 8000;
/** A job in progress survives a reload, so its credits aren't left held. */
const ACTIVE_JOB_KEY = "eleenai.studio.job";

function remember(id: string | null): void {
	try {
		if (id) localStorage.setItem(ACTIVE_JOB_KEY, id);
		else localStorage.removeItem(ACTIVE_JOB_KEY);
	} catch {
		// A reload then loses sight of the job. The job itself is unaffected.
	}
}

function recall(): string | null {
	try {
		return localStorage.getItem(ACTIVE_JOB_KEY);
	} catch {
		return null;
	}
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export async function loadStudio(): Promise<StudioState | null> {
	try {
		return (await (await request("/api/media/studio", { auth: true })).json()) as StudioState;
	} catch (error) {
		if (error instanceof ApiError && (error.status === 404 || error.kind === "unauthorized")) return null;
		throw error;
	}
}

export function renderTeaser(root: HTMLElement): void {
	const back = element("a", "studio-back", t("studioBack"));
	back.href = "/";
	root.replaceChildren(
		element("span", "studio-badge", t("studioSoon")),
		element("h1", undefined, t("studioTitle")),
		element("p", "studio-lead", t("studioTeaser")),
		back,
	);
}

export function renderStudio(root: HTMLElement, state: StudioState): void {
	let balance = state.balance;
	const balanceLine = element("p", "studio-balance", t("studioBalance", { credits: balance }));

	const form = element("form", "studio-form");
	const promptLabel = element("label", undefined, t("studioPrompt"));
	const prompt = element("textarea");
	prompt.required = true;
	prompt.maxLength = 2000;
	promptLabel.append(prompt);

	const modelLabel = element("label", undefined, t("studioModel"));
	const select = element("select");
	for (const model of state.models) {
		const option = element("option", undefined, t("studioModelOption", { label: model.label, credits: model.credits }));
		option.value = model.id;
		select.append(option);
	}
	modelLabel.append(select);

	const generate = element("button", "studio-generate", t("studioGenerate"));
	generate.type = "submit";
	form.append(promptLabel, modelLabel, generate);

	const status = element("p", "studio-status");
	status.setAttribute("aria-live", "polite");
	const video = element("video", "studio-video");
	video.controls = true;
	video.hidden = true;

	root.replaceChildren(element("h1", undefined, t("studioTitle")), element("p", "studio-lead", t("studioLead")), balanceLine, form, status, video);

	const say = (text: string, kind: "info" | "error" = "info") => {
		status.textContent = text;
		status.dataset.kind = kind;
	};

	let timer: ReturnType<typeof setTimeout> | null = null;

	const finish = (job: Job) => {
		remember(null);
		generate.disabled = false;
		if (job.status === "succeeded" && job.videoUrl) {
			say(t("studioDone"));
			video.src = job.videoUrl;
			video.hidden = false;
		} else {
			say(t("studioFailed"), "error");
		}
		void loadStudio().then((fresh) => {
			if (fresh) {
				balance = fresh.balance;
				balanceLine.textContent = t("studioBalance", { credits: balance });
			}
		});
	};

	const poll = (id: string) => {
		timer = setTimeout(async () => {
			// A hidden tab doesn't need a video yet. It carries on when it's back.
			if (document.hidden) return poll(id);
			try {
				const job = (await (await request(`/api/media/jobs/${id}`, { auth: true })).json()) as Job;
				if (job.status === "running") poll(id);
				else finish(job);
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) {
					remember(null);
					generate.disabled = false;
					return;
				}
				poll(id);
			}
		}, POLL_MS);
	};

	const watch = (id: string) => {
		generate.disabled = true;
		video.hidden = true;
		say(t("studioWorking"));
		poll(id);
	};

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const model = state.models.find((m) => m.id === select.value);
		const text = prompt.value.trim();
		if (!model || !text || generate.disabled) return;

		generate.disabled = true;
		say(t("studioStarting"));
		// A new id per click: a retry of one request can't start a second job.
		const id = crypto.randomUUID();
		try {
			const response = await request("/api/media/video", {
				method: "POST",
				auth: true,
				body: { id, prompt: text, model: model.id, quotedCredits: model.credits },
			});
			await response.json();
			remember(id);
			balance -= model.credits;
			balanceLine.textContent = t("studioBalance", { credits: balance });
			watch(id);
		} catch (error) {
			generate.disabled = false;
			if (error instanceof ApiError && error.status === 403) say(t("studioBlocked"), "error");
			else say(error instanceof ApiError ? error.message : t("errorGeneric"), "error");
		}
	});

	const active = recall();
	if (active) watch(active);

	window.addEventListener("pagehide", () => {
		if (timer) clearTimeout(timer);
	});
}
