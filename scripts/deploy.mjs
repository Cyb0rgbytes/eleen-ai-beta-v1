#!/usr/bin/env node
/**
 * Deploy from a clean checkout, stamping the build with its commit.
 *
 * `wrangler deploy` uploads the working directory, not a branch. Twice this
 * year a deploy run from a stale checkout published old code and the only
 * way to tell was a 404 on a route that existed in source. The health
 * endpoint now reports BUILD_SHA, set here from `git rev-parse HEAD`, so
 * scripts/verify-deploy.mjs can prove what production runs.
 *
 * Refuses a dirty working tree unless --allow-dirty is passed: a deploy that
 * includes uncommitted edits cannot be matched to any commit afterwards.
 */
import { execSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const allowDirty = args.includes("--allow-dirty");
const passthrough = args.filter((a) => a !== "--allow-dirty");

function git(cmd) {
	return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

const sha = git("rev-parse HEAD");
const branch = git("rev-parse --abbrev-ref HEAD");
const dirty = git("status --porcelain --untracked-files=no") !== "";

if (dirty && !allowDirty) {
	console.error("Working tree has uncommitted tracked changes. Commit them, or pass --allow-dirty.");
	process.exit(1);
}
if (branch !== "main") {
	console.warn(`Deploying from branch "${branch}", not main.`);
}

const stamp = dirty ? `${sha}-dirty` : sha;
console.log(`Deploying ${stamp.slice(0, 12)} from ${branch}`);

const result = spawnSync(
	process.platform === "win32" ? "npx.cmd" : "npx",
	["wrangler", "deploy", "--var", `BUILD_SHA:${stamp}`, ...passthrough],
	{ stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
