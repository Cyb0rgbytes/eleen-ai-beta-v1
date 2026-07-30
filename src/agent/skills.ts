/**
 * Item 10 — /.well-known/agent-skills/index.json and the skill documents.
 *
 * https://github.com/cloudflare/agent-skills-discovery-rfc
 *
 * Digests are computed at runtime from the exact strings this module serves,
 * memoized after the first request. The build script
 * (scripts/gen-skill-digests.mjs) validates front matter and catches BOM/CRLF
 * damage, but it is a lint rather than the source of truth: computing the
 * digest here makes it structurally impossible for the published value to
 * disagree with the bytes a client actually fetches and hashes.
 */
import { absolute } from "./config";
import CHAT_SKILL from "./content/skills/eleenai-chat/SKILL.md";
import IMAGE_SKILL from "./content/skills/eleenai-image-generation/SKILL.md";
import SEARCH_SKILL from "./content/skills/eleenai-web-search/SKILL.md";

export const SCHEMA_URL = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

interface Skill {
	name: string;
	description: string;
	content: string;
}

/**
 * Descriptions are duplicated from each document's front matter rather than
 * parsed out of it. The build script asserts the two agree, so a mismatch is
 * a build failure rather than a silent drift.
 */
export const SKILLS: Skill[] = [
	{
		name: "eleenai-chat",
		description:
			"Converse with the EleenAI assistant over its HTTP API, including SSE stream " +
			"parsing, response modes, file attachments, and the guest versus authenticated tiers.",
		content: CHAT_SKILL,
	},
	{
		name: "eleenai-image-generation",
		description:
			"Generate images from text prompts using the EleenAI image endpoint, which " +
			"returns raw image bytes rather than JSON.",
		content: IMAGE_SKILL,
	},
	{
		name: "eleenai-web-search",
		description:
			"Answer questions with live web search through EleenAI, returning a grounded " +
			"answer together with the source URLs it was based on.",
		content: SEARCH_SKILL,
	},
];

const SKILLS_BY_NAME = new Map(SKILLS.map((skill) => [skill.name, skill]));

export function findSkill(name: string): Skill | undefined {
	return SKILLS_BY_NAME.get(name);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Memoized across requests within an isolate; the content never changes. */
let indexPromise: Promise<unknown> | null = null;

export function buildSkillsIndex(): Promise<unknown> {
	if (!indexPromise) {
		indexPromise = (async () => ({
			$schema: SCHEMA_URL,
			skills: await Promise.all(
				SKILLS.map(async (skill) => {
					const hex = await sha256Hex(skill.content);
					return {
						name: skill.name,
						type: "skill-md",
						description: skill.description,
						url: absolute(`/.well-known/agent-skills/${skill.name}/SKILL.md`),
						// The RFC field is `digest`, formatted sha256:{hex}.
						digest: `sha256:${hex}`,
						// Bare alias, for tooling that looks for `sha256`.
						// Additional properties are permitted by the schema.
						sha256: hex,
					};
				}),
			),
		}))();
	}

	return indexPromise;
}
