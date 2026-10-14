/**
 * Markdown files are compiled into the bundle as strings via the `Text` rule
 * in wrangler.jsonc. This tells TypeScript what those imports evaluate to.
 */
declare module "*.md" {
	const content: string;
	export default content;
}
