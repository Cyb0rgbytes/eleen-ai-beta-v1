/**
 * One upload to POST /api/v1/files, with progress (M5.2).
 *
 * XMLHttpRequest rather than fetch: fetch still reports no upload progress
 * in most browsers. Loaded on demand by chat/attachments.ts the first time a
 * file is attached, so the initial bundle does not carry it.
 *
 * The body is the file itself; the name travels percent-encoded in
 * x-file-name. The server decides the type from the bytes, so the
 * Content-Type sent here is only a hint.
 */
import type { UploadedFile } from "../../../src/shared/files";
import { sessionToken } from "../api/client";

export type UploadFailure = "too-large" | "unsupported-type" | "unreadable" | "rate-limited" | "unauthorized" | "aborted" | "failed";

export class UploadError extends Error {
	constructor(readonly reason: UploadFailure) {
		super(reason);
		this.name = "UploadError";
	}
}

export interface UploadHandle {
	done: Promise<UploadedFile>;
	abort(): void;
}

function failure(status: number, body: unknown): UploadFailure {
	const reason = typeof body === "object" && body !== null ? (body as { reason?: unknown }).reason : undefined;
	if (status === 413) return "too-large";
	if (status === 415) return "unsupported-type";
	if (status === 422 && reason === "unreadable") return "unreadable";
	if (status === 429) return "rate-limited";
	if (status === 401) return "unauthorized";
	return "failed";
}

export function uploadFile(file: File, onProgress: (fraction: number) => void): UploadHandle {
	const xhr = new XMLHttpRequest();
	let aborted = false;
	const done = (async () => {
		const token = await sessionToken();
		if (aborted) throw new UploadError("aborted");
		return new Promise<UploadedFile>((resolve, reject) => {
			xhr.open("POST", "/api/v1/files");
			xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
			xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
			xhr.setRequestHeader("accept", "application/json");
			if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
			xhr.responseType = "json";
			xhr.upload.addEventListener("progress", (event) => {
				if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
			});
			xhr.addEventListener("load", () => {
				const body: unknown = xhr.response;
				if (xhr.status === 201 && body && typeof body === "object" && "file" in body) {
					onProgress(1);
					resolve((body as { file: UploadedFile }).file);
				} else {
					reject(new UploadError(failure(xhr.status, body)));
				}
			});
			xhr.addEventListener("error", () => reject(new UploadError("failed")));
			xhr.addEventListener("abort", () => reject(new UploadError("aborted")));
			xhr.send(file);
		});
	})();
	return {
		done,
		abort() {
			aborted = true;
			xhr.abort();
		},
	};
}
