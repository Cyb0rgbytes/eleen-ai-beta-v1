/**
 * Toasts (DESIGN.md section 7): bottom inline-end, one line, auto-dismiss
 * at 4 s, with a visible dismiss control. role="status" so screen readers
 * announce them without stealing focus.
 */
import { icon } from "./icons";
import { t } from "../i18n";

export type ToastKind = "info" | "success" | "error";

const ICON = { info: "sparkle", success: "check-circle", error: "warning-circle" } as const;
const DEFAULT_MS = 4000;

function dismiss(toast: HTMLElement): void {
	if (toast.classList.contains("fade-out")) return;
	toast.classList.add("fade-out");
	// The exit animation is 240 ms; under reduced motion it is 0 and
	// animationend may not fire, so a timer is the backstop.
	const remove = () => toast.remove();
	toast.addEventListener("animationend", remove, { once: true });
	setTimeout(remove, 300);
}

export interface ToastAction {
	label: string;
	onClick(): void;
}

/**
 * `action` adds one text button before the dismiss control (the sidebar's
 * Undo). Pressing it runs onClick and dismisses the toast.
 */
export function showToast(
	message: string,
	kind: ToastKind = "info",
	durationMs = DEFAULT_MS,
	options: { action?: ToastAction } = {},
): HTMLElement {
	const toast = document.createElement("div");
	toast.className = `toast ${kind}`;
	toast.setAttribute("role", kind === "error" ? "alert" : "status");

	const text = document.createElement("span");
	text.className = "toast-text";
	text.textContent = message;

	const close = document.createElement("button");
	close.type = "button";
	close.className = "toast-close";
	close.append(icon("x"));
	const label = document.createElement("span");
	label.className = "sr-only";
	label.textContent = t("dismiss");
	close.append(label);
	close.addEventListener("click", () => dismiss(toast));

	toast.append(icon(ICON[kind]), text);
	if (options.action) {
		const { label: actionLabel, onClick } = options.action;
		const action = document.createElement("button");
		action.type = "button";
		action.className = "toast-action";
		action.textContent = actionLabel;
		action.addEventListener("click", () => {
			dismiss(toast);
			onClick();
		});
		toast.append(action);
	}
	toast.append(close);
	document.body.append(toast);
	setTimeout(() => dismiss(toast), durationMs);
	return toast;
}
