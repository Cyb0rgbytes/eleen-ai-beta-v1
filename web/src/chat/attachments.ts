/**
 * Attachments in the composer (M5.2): the attach button, drag and drop and
 * paste onto the composer, a chip per file with upload progress and remove,
 * and the chips shown on sent user turns.
 *
 * Signed-in only, as uploads are. A guest still sees the button (DESIGN.md
 * puts attach in the pill), and pressing it, dropping or pasting a file asks
 * them to sign in, the same way a locked model does.
 *
 * Files upload as soon as they are added; Send takes the finished ones
 * (takeFiles) and the controller sends their ids with the turn. Removing a
 * chip before sending cancels the upload or deletes the stored file.
 *
 *   .file-tray                         above the input row, hidden when empty
 *     .file-chip[data-state]           uploading | ready | failed
 *       svg.icon  .file-chip-name  .file-chip-meta  .file-chip-progress  button.file-chip-remove
 */
import type { FileRef } from "../../../src/shared/files";
import { MAX_FILE_BYTES, MAX_FILES_PER_TURN } from "../../../src/shared/files";
import { request } from "../api/client";
import { isSignedIn, openSignIn } from "../auth/clerk";
import { t, type MessageKey } from "../i18n";
import { icon, setIcon } from "../ui/icons";
import { showToast } from "../ui/toast";
import type { UploadFailure, UploadHandle } from "../files/upload";

/** What the file picker offers; the server still decides from the bytes. */
const ACCEPT = ".pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.markdown,.csv,application/pdf,image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,text/csv";

interface Item {
	chip: HTMLElement;
	state: "uploading" | "ready" | "failed";
	file?: FileRef;
	handle?: UploadHandle;
}

const items: Item[] = [];
let tray: HTMLElement | null = null;

const FAILURE: Record<UploadFailure, MessageKey> = {
	"too-large": "uploadTooLarge",
	"unsupported-type": "uploadUnsupported",
	unreadable: "uploadUnreadable",
	"rate-limited": "uploadRateLimited",
	unauthorized: "uploadSignIn",
	aborted: "uploadFailed",
	failed: "uploadFailed",
};

export function formatSize(bytes: number): string {
	if (bytes < 1024 * 1024) return t("fileSizeKb", { size: Math.max(1, Math.round(bytes / 1024)) });
	return t("fileSizeMb", { size: (bytes / (1024 * 1024)).toFixed(1) });
}

/** A chip's content: kind icon, name, size. Shared by the tray and sent turns. */
function chipBody(name: string, size: number, kind: FileRef["kind"]): HTMLElement {
	const chip = document.createElement("div");
	chip.className = "file-chip";
	chip.append(icon(kind === "image" ? "image" : "file-text"));
	const label = document.createElement("span");
	label.className = "file-chip-name";
	label.dir = "auto";
	label.textContent = name;
	label.title = name;
	const meta = document.createElement("span");
	meta.className = "file-chip-meta";
	meta.textContent = formatSize(size);
	chip.append(label, meta);
	return chip;
}

const guessKind = (file: File): FileRef["kind"] => (file.type.startsWith("image/") ? "image" : "document");

/** Chips for a sent user turn (live or reopened). `turn` is the bubble or a node containing it. */
export function appendFileChips(turn: HTMLElement, files: readonly FileRef[] | undefined): void {
	if (!files?.length) return;
	const bubble = turn.classList.contains("user-message") ? turn : turn.querySelector<HTMLElement>(".user-message");
	if (!bubble) return;
	const list = document.createElement("div");
	list.className = "file-chips";
	list.setAttribute("aria-label", t("attachedFiles"));
	for (const file of files) {
		const chip = chipBody(file.name, file.size, file.kind);
		chip.dataset.fileId = file.id;
		chip.dataset.state = "sent";
		list.append(chip);
	}
	bubble.append(list);
}

export function hasPendingUploads(): boolean {
	return items.some((i) => i.state === "uploading");
}

export function hasReadyFiles(): boolean {
	return items.some((i) => i.state === "ready");
}

/** The finished uploads, for the turn being sent; the tray empties. */
export function takeFiles(): FileRef[] {
	const ready = items.filter((i) => i.state === "ready" && i.file).map((i) => i.file as FileRef);
	for (const item of [...items]) {
		if (item.state !== "uploading") remove(item, { keepStored: true });
	}
	return ready;
}

function sync(): void {
	if (tray) tray.hidden = items.length === 0;
}

function remove(item: Item, { keepStored = false } = {}): void {
	const at = items.indexOf(item);
	if (at >= 0) items.splice(at, 1);
	item.chip.remove();
	if (item.state === "uploading") item.handle?.abort();
	// A stored file that will not be sent is deleted rather than left behind.
	if (!keepStored && item.state === "ready" && item.file) {
		void request(`/api/v1/files/${encodeURIComponent(item.file.id)}`, { method: "DELETE", auth: true }).catch(() => {});
	}
	sync();
}

function askToSignIn(): void {
	showToast(t("uploadSignIn"), "info", 5000, { action: { label: t("signIn"), onClick: () => void openSignIn() } });
}

async function add(files: readonly File[]): Promise<void> {
	if (!files.length || !tray) return;
	if (!isSignedIn()) {
		askToSignIn();
		return;
	}
	const room = MAX_FILES_PER_TURN - items.length;
	if (files.length > room) showToast(t("uploadTooMany", { count: MAX_FILES_PER_TURN }), "error");
	const accepted = files.slice(0, Math.max(room, 0));
	if (!accepted.length) return;

	const { uploadFile, UploadError } = await import("../files/upload");
	for (const file of accepted) {
		if (file.size > MAX_FILE_BYTES) {
			showToast(t("uploadTooLarge"), "error");
			continue;
		}
		const chip = chipBody(file.name, file.size, guessKind(file));
		chip.dataset.state = "uploading";
		const progress = document.createElement("span");
		progress.className = "file-chip-progress";
		progress.setAttribute("role", "progressbar");
		progress.setAttribute("aria-label", t("uploading", { name: file.name }));
		progress.setAttribute("aria-valuemin", "0");
		progress.setAttribute("aria-valuemax", "100");
		progress.setAttribute("aria-valuenow", "0");
		const bar = document.createElement("span");
		bar.className = "file-chip-bar";
		progress.append(bar);

		const close = document.createElement("button");
		close.type = "button";
		close.className = "file-chip-remove";
		setIcon(close, "x");
		const closeLabel = document.createElement("span");
		closeLabel.className = "sr-only";
		closeLabel.textContent = t("removeFile", { name: file.name });
		close.append(closeLabel);
		close.title = t("removeFile", { name: file.name });
		chip.append(progress, close);

		const item: Item = { chip, state: "uploading" };
		close.addEventListener("click", () => remove(item));
		items.push(item);
		tray.append(chip);
		sync();

		item.handle = uploadFile(file, (fraction) => {
			const percent = Math.round(fraction * 100);
			bar.style.transform = `scaleX(${fraction})`;
			progress.setAttribute("aria-valuenow", String(percent));
		});
		item.handle.done.then(
			(stored) => {
				if (!items.includes(item)) {
					// Removed while the last bytes were in flight.
					void request(`/api/v1/files/${encodeURIComponent(stored.id)}`, { method: "DELETE", auth: true }).catch(() => {});
					return;
				}
				item.state = "ready";
				item.file = { id: stored.id, name: stored.name, type: stored.type, size: stored.size, kind: stored.kind };
				chip.dataset.state = "ready";
				chip.dataset.fileId = stored.id;
				progress.remove();
			},
			(error: unknown) => {
				if (!items.includes(item)) return;
				const reason: UploadFailure = error instanceof UploadError ? error.reason : "failed";
				showToast(t(FAILURE[reason], { count: MAX_FILES_PER_TURN }), "error");
				item.state = "failed";
				remove(item);
			},
		);
	}
}

/** Build the button, tray and drop target. Called once by the composer. */
export function initAttachments(): void {
	const composer = document.querySelector<HTMLElement>(".message-input");
	const row = composer?.querySelector<HTMLElement>(".input-row");
	const input = document.getElementById("user-input") as HTMLTextAreaElement | null;
	if (!composer || !row || !input || tray) return;

	tray = document.createElement("div");
	tray.className = "file-tray";
	tray.setAttribute("aria-label", t("attachedFiles"));
	tray.hidden = true;
	composer.insertBefore(tray, row);

	const picker = document.createElement("input");
	picker.type = "file";
	picker.multiple = true;
	picker.accept = ACCEPT;
	picker.hidden = true;
	picker.id = "attach-input";
	picker.tabIndex = -1;

	const button = document.createElement("button");
	button.type = "button";
	button.id = "attach-button";
	button.title = t("attachFiles");
	setIcon(button, "paperclip");
	const label = document.createElement("span");
	label.className = "sr-only";
	label.textContent = t("attachFiles");
	button.append(label);
	row.insertBefore(button, input);
	row.append(picker);

	button.addEventListener("click", () => {
		if (!isSignedIn()) {
			askToSignIn();
			return;
		}
		picker.click();
	});
	picker.addEventListener("change", () => {
		const files = Array.from(picker.files ?? []);
		picker.value = "";
		void add(files);
	});

	const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
	composer.addEventListener("dragover", (event) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		composer.classList.add("is-dragover");
	});
	composer.addEventListener("dragleave", (event) => {
		if (event.relatedTarget instanceof Node && composer.contains(event.relatedTarget)) return;
		composer.classList.remove("is-dragover");
	});
	composer.addEventListener("drop", (event) => {
		if (!hasFiles(event)) return;
		event.preventDefault();
		composer.classList.remove("is-dragover");
		void add(Array.from(event.dataTransfer?.files ?? []));
	});

	// Pasting a screenshot or a copied file attaches it; pasting text is untouched.
	input.addEventListener("paste", (event) => {
		const files = Array.from(event.clipboardData?.files ?? []);
		if (!files.length) return;
		event.preventDefault();
		void add(files);
	});
}
