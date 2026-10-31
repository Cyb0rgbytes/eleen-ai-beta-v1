/**
 * Paid generation must stay reachable only from Studio. These read the source
 * because the guarantee is an absence: no agent surface and no chat path may
 * ever name a paid route.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): [string, string][] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((file) => /\.(ts|md|json)$/.test(file))
		.map((file) => [file, readFileSync(join(dir, file), "utf8")]);
}

describe("cron triggers", () => {
	it("in wrangler.jsonc are exactly the ones the scheduled handler names", () => {
		const configured = readFileSync("wrangler.jsonc", "utf8").match(/"crons":\s*\[([^\]]*)\]/)?.[1] ?? "";
		const crons = [...configured.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
		const source = readFileSync("src/lib/crons.ts", "utf8");
		const named = [...source.matchAll(/export const (?:SWEEP|PURGE)_CRON = "([^"]+)"/g)].map((match) => match[1]).sort();
		expect(crons).toHaveLength(2);
		expect(crons).toEqual(named);
	});
});

describe("the main module", () => {
	it("exports nothing workerd can't treat as an entrypoint", () => {
		// A top-level exported constant stops the Worker starting, and neither
		// the unit tests nor a dry-run deploy notice: only a real start does.
		const index = readFileSync("src/index.ts", "utf8");
		expect(index.match(/^export (?:const|let|var) .*$/gm) ?? []).toEqual([]);
	});
});

describe("paid routes", () => {
	it("are not named by the MCP tools, OpenAPI, docs or skills", () => {
		const files = sources("src/agent");
		expect(files.length).toBeGreaterThan(5);
		for (const [file, text] of files) {
			expect(`${file}: ${/\/api\/media|src\/media|handleVideo/.test(text)}`).toBe(`${file}: false`);
		}
	});

	it("are not named by the chat", () => {
		const files = sources("web/src/chat");
		expect(files.length).toBeGreaterThan(5);
		for (const [file, text] of files) {
			expect(`${file}: ${text.includes("/api/media")}`).toBe(`${file}: false`);
		}
	});

	it("leave the free image route without any credit or fal code", () => {
		const index = readFileSync("src/index.ts", "utf8");
		const start = index.indexOf("export async function handleImageGenerate");
		const end = index.indexOf("// ─── Vision Analysis");
		expect(start).toBeGreaterThan(0);
		expect(index.slice(start, end)).not.toMatch(/credits|hold\(|submitFal|FAL_KEY/);
	});
});
