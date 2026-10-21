/**
 * The test auth seam (src/lib/auth.ts) is safe only while nothing in the
 * Worker turns it on. It is a module variable with one setter, so "nothing
 * calls the setter" is the whole guarantee, and this checks it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|js|mjs)$/.test(name) ? [path] : [];
	});
}

describe("test auth seam", () => {
	it("is set nowhere in the Worker source", () => {
		const callers = sourceFiles(SRC)
			.filter((path) => readFileSync(path, "utf8").includes("setTestAuthenticator"))
			.map((path) => relative(SRC, path).replace(/\\/g, "/"));
		expect(callers).toEqual(["lib/auth.ts"]);
	});

	it("starts off", async () => {
		const { testAuthenticate } = await import("../src/lib/auth");
		expect(testAuthenticate(new Request("https://eleenai.xyz/api/v1/conversations", { headers: { "x-test-user": "x" } }))).toBeUndefined();
	});
});
