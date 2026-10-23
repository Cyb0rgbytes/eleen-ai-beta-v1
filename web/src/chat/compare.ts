/**
 * A compare turn (M5.4): 2 or 3 models answering one message, side by side.
 *
 *   .compare-turn[data-message-id]     the id of the lane the thread goes on from
 *     .compare-head                    label, then the ‹ n/m › navigator (render.ts)
 *     .compare-tabs[role=tablist]      one tab per model; shown below 1024px only
 *     .compare-lanes
 *       section.compare-lane[role=tabpanel][data-lane][data-lane-message-id]
 *         .compare-lane-head           model name, and "Continuing from this answer"
 *         .message.assistant-message   the ordinary reply view (render.ts)
 *         .compare-lane-foot           "Continue with this answer"
 *
 * Columns on wide screens, tabs on narrow ones (DESIGN.md section 7): the
 * markup is the same, the stylesheet decides. Below 1024px only the lane
 * whose tab is selected shows; above it every lane shows and the tabs hide.
 *
 * Each lane's reply is a createAssistantMessage view, so streaming, the
 * reasoning panel, usage and Copy behave as in any reply. A lane offers no
 * Regenerate and no rating: those belong to a single answer. A lane's root
 * carries data-lane-message-id, never data-message-id, so the controller's
 * navigator pass sees the compare turn once.
 */
import { t } from "../i18n";
import { icon } from "../ui/icons";
import { createAssistantMessage, type AssistantView } from "./render";

export interface CompareLane {
	readonly root: HTMLElement;
	readonly view: AssistantView;
	setLabel(label: string): void;
	/** A saved lane's message id, for Continue. */
	setMessageId(id: string): void;
	/** The reply has ended: drop the controls a lane does not offer. */
	settle(): void;
}

export interface CompareTurn {
	readonly root: HTMLElement;
	readonly lanes: readonly CompareLane[];
	/** Show this lane's tab (narrow screens). */
	select(index: number): void;
	/** The lane the conversation continues from, or null while undecided. */
	setChosen(index: number | null): void;
	/** Offer "Continue with this answer" on the lanes not chosen. */
	setContinuable(on: boolean): void;
}

let counter = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	return node;
}

/** A readable name for a model id the listing did not name: its last path part. */
export function fallbackModelLabel(id: string | null): string {
	if (!id) return t("thisModel");
	return id.split("/").pop() || id;
}

export function createCompareTurn(labels: readonly string[]): CompareTurn {
	const turnId = `compare-${++counter}`;
	const root = el("div", "compare-turn");
	root.setAttribute("role", "group");
	root.setAttribute("aria-label", t("compareTurnLabel", { count: labels.length }));
	root.style.setProperty("--lanes", String(labels.length));

	const head = el("div", "compare-head");
	const title = el("span", "compare-title");
	title.append(icon("columns"));
	const titleText = el("span");
	titleText.textContent = t("compareTurnLabel", { count: labels.length });
	title.append(titleText);
	head.append(title);

	const tabs = el("div", "compare-tabs");
	tabs.setAttribute("role", "tablist");
	tabs.setAttribute("aria-label", t("compareTabs"));
	const body = el("div", "compare-lanes");

	let chosen: number | null = null;
	let continuable = false;
	const tabButtons: HTMLButtonElement[] = [];

	const lanes = labels.map((label, index): CompareLane => {
		const tab = el("button", "compare-tab");
		tab.type = "button";
		tab.id = `${turnId}-tab-${index}`;
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-controls", `${turnId}-lane-${index}`);
		const tabLabel = el("span", "compare-tab-label");
		tab.append(tabLabel);
		tab.addEventListener("click", () => turn.select(index));
		tabButtons.push(tab);
		tabs.append(tab);

		const lane = el("section", "compare-lane");
		lane.id = `${turnId}-lane-${index}`;
		lane.dataset.lane = String(index);
		lane.setAttribute("role", "tabpanel");
		lane.setAttribute("aria-labelledby", tab.id);

		const laneHead = el("div", "compare-lane-head");
		const model = el("span", "compare-lane-model");
		const status = el("span", "compare-lane-chosen");
		status.append(icon("check"));
		const statusText = el("span");
		statusText.textContent = t("compareContinuing");
		status.append(statusText);
		status.hidden = true;
		laneHead.append(model, status);

		const view = createAssistantMessage();
		view.root.classList.add("compare-reply");
		// The wait for this lane's first token: lines inside its own panel
		// (DESIGN.md principle 7). The first paint, a failure or a replay
		// replaces the panel's contents, and the skeleton with them.
		const skeleton = el("div", "compare-skeleton");
		skeleton.setAttribute("aria-hidden", "true");
		for (const width of ["92%", "78%", "54%"]) {
			const line = el("div", "skeleton-line");
			line.style.inlineSize = width;
			skeleton.append(line);
		}
		view.root.querySelector(".message-body")?.append(skeleton);

		const foot = el("div", "compare-lane-foot");
		const next = el("button", "compare-continue");
		next.type = "button";
		next.dataset.action = "continue";
		next.dataset.lane = String(index);
		next.append(icon("arrow-right"));
		const nextText = el("span");
		nextText.textContent = t("compareContinue");
		next.append(nextText);
		foot.append(next);
		foot.hidden = true;

		lane.append(laneHead, view.root, foot);
		body.append(lane);

		const setLabel = (text: string) => {
			model.textContent = text;
			tabLabel.textContent = text;
		};
		setLabel(label);

		return {
			root: lane,
			view,
			setLabel,
			setMessageId(id) {
				lane.dataset.laneMessageId = id;
				next.dataset.laneMessageId = id;
			},
			settle() {
				view.root.querySelectorAll(".regenerate-button, [data-feedback]").forEach((node) => node.remove());
			},
		};
	});

	function sync() {
		lanes.forEach((lane, index) => {
			const isChosen = chosen === index;
			lane.root.classList.toggle("is-chosen", isChosen);
			const status = lane.root.querySelector<HTMLElement>(".compare-lane-chosen");
			if (status) status.hidden = !isChosen;
			const foot = lane.root.querySelector<HTMLElement>(".compare-lane-foot");
			if (foot) foot.hidden = !continuable || isChosen;
			tabButtons[index]?.classList.toggle("is-chosen", isChosen);
		});
	}

	// Arrow keys move between tabs along the reading direction; one tab stop.
	tabs.addEventListener("keydown", (event) => {
		const rtl = document.documentElement.dir === "rtl";
		const steps: Record<string, number> = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };
		const current = tabButtons.findIndex((b) => b.getAttribute("aria-selected") === "true");
		let target: number | null = null;
		if (event.key in steps) target = (current + (steps[event.key] as number) + lanes.length) % lanes.length;
		else if (event.key === "Home") target = 0;
		else if (event.key === "End") target = lanes.length - 1;
		if (target === null) return;
		event.preventDefault();
		turn.select(target);
		tabButtons[target]?.focus();
	});

	root.append(head, tabs, body);

	const turn: CompareTurn = {
		root,
		lanes,
		select(index) {
			tabButtons.forEach((tab, i) => {
				const on = i === index;
				tab.setAttribute("aria-selected", String(on));
				tab.tabIndex = on ? 0 : -1;
				lanes[i]?.root.classList.toggle("is-current", on);
			});
		},
		setChosen(index) {
			chosen = index;
			sync();
		},
		setContinuable(on) {
			continuable = on;
			sync();
		},
	};
	turn.select(0);
	sync();
	return turn;
}
