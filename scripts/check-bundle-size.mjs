#!/usr/bin/env node
/**
 * Fail the build if the page's initial JavaScript is over budget.
 *
 * Budget: 80 KB gzipped, counting every same-origin script and
 * modulepreload that dist/index.html loads before interaction. External
 * scripts (Clerk, the Spline viewer) are excluded: they are not ours to
 * size, and DESIGN.md tracks them separately.
 *
 *   node scripts/check-bundle-size.mjs [budgetKB]
 */
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const budgetKB = Number(process.argv[2] ?? 80);
const dist = "dist";
const indexPath = join(dist, "index.html");

if (!existsSync(indexPath)) {
	console.error("dist/index.html not found. Run `npm run build` first.");
	process.exit(2);
}

const html = readFileSync(indexPath, "utf8");
const refs = new Set();
for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) refs.add(m[1]);
for (const m of html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) refs.add(m[1]);

let total = 0;
const rows = [];
for (const ref of refs) {
	if (/^https?:\/\//.test(ref)) continue;
	const file = join(dist, ref.replace(/^\//, ""));
	if (!existsSync(file)) {
		console.error(`Referenced script missing from dist: ${ref}`);
		process.exit(2);
	}
	const gz = gzipSync(readFileSync(file)).length;
	total += gz;
	rows.push([ref, gz]);
}

for (const [ref, gz] of rows) console.log(`${(gz / 1024).toFixed(1).padStart(7)} KB  ${ref}`);
console.log(`${(total / 1024).toFixed(1).padStart(7)} KB  total initial JS (gzip), budget ${budgetKB} KB`);

if (total > budgetKB * 1024) {
	console.error("Over budget.");
	process.exit(1);
}
