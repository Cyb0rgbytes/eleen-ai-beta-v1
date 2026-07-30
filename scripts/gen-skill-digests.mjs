#!/usr/bin/env node
/**
 * Generate src/agent/content/skill-manifest.json from the SKILL.md files.
 *
 * The agent-skills discovery index publishes a SHA-256 digest of each skill
 * document. A digest that does not match the bytes actually served is worse
 * than publishing no digest at all, so this script is deliberately strict
 * about anything that could make the bytes vary between machines.
 *
 * Usage:
 *   node scripts/gen-skill-digests.mjs                 regenerate the manifest
 *   node scripts/gen-skill-digests.mjs --check         fail if stale (CI)
 *   node scripts/gen-skill-digests.mjs --print-card-digest
 *
 * Zero dependencies by design — this runs in a predeploy hook.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, "src", "agent", "content", "skills");
const MANIFEST = join(ROOT, "src", "agent", "content", "skill-manifest.json");

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 1024;

const problems = [];

function fail(skill, message) {
	problems.push(`  ${skill}: ${message}`);
}

/**
 * Minimal YAML front matter reader — enough for `name` and `description`,
 * and not worth a dependency in a predeploy hook.
 */
function parseFrontMatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
	if (!match) return null;

	const fields = {};
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) fields[key] = value;
	}
	return fields;
}

function collect() {
	if (!existsSync(SKILLS_DIR)) {
		console.error(`No skills directory at ${SKILLS_DIR}`);
		process.exit(1);
	}

	// Sorted so the manifest is byte-stable regardless of filesystem order.
	const names = readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

	const skills = [];

	for (const name of names) {
		const path = join(SKILLS_DIR, name, "SKILL.md");
		if (!existsSync(path)) {
			fail(name, "no SKILL.md in this directory");
			continue;
		}

		const buffer = readFileSync(path);

		// A UTF-8 BOM is stripped by esbuild's text loader, so the digest of the
		// file on disk would not match the bytes the Worker serves.
		if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
			fail(name, "file begins with a UTF-8 BOM — strip it; esbuild removes it at build time, so the digest would not match what is served");
			continue;
		}

		// CRLF survives the text loader, so a file checked out with CRLF on
		// Windows and LF on Linux produces two different digests from one
		// commit. .gitattributes pins eol=lf; this catches a bypass of it.
		if (buffer.includes(0x0d)) {
			fail(name, "contains CR bytes (CRLF line endings) — the digest would differ between platforms; check .gitattributes and re-checkout the file");
			continue;
		}

		const text = buffer.toString("utf8");
		const front = parseFrontMatter(text);

		if (!front) {
			fail(name, "missing YAML front matter delimited by ---");
			continue;
		}
		if (front.name !== name) {
			fail(name, `front matter name "${front.name}" does not match the directory name`);
			continue;
		}
		if (!NAME_PATTERN.test(name) || name.length > 64) {
			fail(name, "name must be lowercase alphanumeric segments joined by hyphens, 1-64 characters");
			continue;
		}
		if (!front.description) {
			fail(name, "front matter is missing a description");
			continue;
		}
		if (front.description.length > MAX_DESCRIPTION) {
			fail(name, `description is ${front.description.length} characters, over the ${MAX_DESCRIPTION} limit`);
			continue;
		}

		skills.push({
			name,
			type: "skill-md",
			description: front.description,
			bytes: buffer.byteLength,
			digest: "sha256:" + createHash("sha256").update(buffer).digest("hex"),
		});
	}

	if (problems.length) {
		console.error("Skill validation failed:\n" + problems.join("\n"));
		process.exit(1);
	}

	if (!skills.length) {
		console.error("No skills found.");
		process.exit(1);
	}

	// No generation timestamp: it would churn the diff on every build and make
	// --check meaningless.
	return JSON.stringify({ skills }, null, 2) + "\n";
}

const args = process.argv.slice(2);

if (args.includes("--print-card-digest")) {
	// The DNS-AID SVCB record carries cap-sha256 over the MCP server card.
	//
	// Fetched rather than derived from source: the digest has to describe the
	// bytes a resolver's client will actually retrieve, and reconstructing
	// those from the TypeScript literal means reimplementing the serializer
	// and hoping the two stay in step. Hash what is served.
	const index = args.indexOf("--print-card-digest");
	const target = args[index + 1] || "https://eleenai.xyz/.well-known/mcp.json";

	const response = await fetch(target);
	if (!response.ok) {
		console.error(`Could not fetch ${target}: HTTP ${response.status}`);
		process.exit(1);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	console.log(`# ${target} (${bytes.byteLength} bytes)`);
	console.log("sha256:" + createHash("sha256").update(bytes).digest("hex"));
	process.exit(0);
}

const generated = collect();

if (args.includes("--check")) {
	const current = existsSync(MANIFEST) ? readFileSync(MANIFEST, "utf8") : "";
	if (current !== generated) {
		console.error(
			"skill-manifest.json is stale. Run: node scripts/gen-skill-digests.mjs",
		);
		process.exit(1);
	}
	console.log("skill-manifest.json is current.");
	process.exit(0);
}

const count = JSON.parse(generated).skills.length;
const existing = existsSync(MANIFEST) ? readFileSync(MANIFEST, "utf8") : null;

// Only write when the content actually changed. wrangler runs this as its
// build command and watches src/, so an unconditional write would touch a
// watched file on every build and spin the dev server in a reload loop.
if (existing === generated) {
	console.log(`${count} skill digest${count === 1 ? "" : "s"} already current.`);
} else {
	writeFileSync(MANIFEST, generated, "utf8");
	console.log(
		`Wrote ${count} skill digest${count === 1 ? "" : "s"} to src/agent/content/skill-manifest.json`,
	);
}
