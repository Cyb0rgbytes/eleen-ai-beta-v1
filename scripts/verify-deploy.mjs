#!/usr/bin/env node
/**
 * Is production running the commit this checkout is on?
 *
 * Fetches /api/v1/health and compares its `build` to `git rev-parse HEAD`.
 * Static assets can be edge-cached, so old HTML proves nothing; the Worker's
 * own report of its build is the reliable check.
 *
 *   node scripts/verify-deploy.mjs [origin]      default https://eleenai.xyz
 */
import { execSync } from "node:child_process";

const origin = process.argv[2] ?? "https://eleenai.xyz";
const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();

const response = await fetch(`${origin}/api/v1/health`, {
	headers: { "cache-control": "no-cache" },
	signal: AbortSignal.timeout(20_000),
});
if (!response.ok) {
	console.error(`${origin}/api/v1/health answered ${response.status}`);
	process.exit(2);
}

const health = await response.json();
const build = health.build ?? null;

console.log(`local HEAD : ${head}`);
console.log(`production : ${build ?? "(no build stamp: deployed without scripts/deploy.mjs)"}`);

if (build === null) process.exit(3);
if (build.endsWith("-dirty")) {
	console.warn("Production was deployed from a dirty working tree.");
}
if (build.replace(/-dirty$/, "") !== head) {
	console.error("Production does not match this checkout.");
	process.exit(1);
}
console.log("Match.");
