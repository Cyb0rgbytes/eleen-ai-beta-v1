import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Three projects (the third, `web`, runs web/src tests in happy-dom):
 *
 * - `unit` runs pure functions (guard, validation, red-team corpus) in Node.
 *   They need no bindings, and the ReDoS checks need a real clock: inside
 *   workerd, performance.now() does not advance during execution, so a timing
 *   assertion there would pass no matter how slow the regex was.
 *
 * - `worker` runs inside workerd against the real Worker with its bindings
 *   (KV, D1, AI stubbed per test), for anything that touches Env or Request.
 *   D1 migrations are read here, in Node, and applied by test/worker/setup.ts.
 */
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["test/**/*.test.ts"],
					exclude: ["test/worker/**"],
					environment: "node",
				},
			},
			{
				// The browser modules under web/src, in a DOM. happy-dom rather
				// than jsdom: faster, and the renderer only needs the DOM core.
				test: {
					name: "web",
					include: ["web/src/**/*.test.ts"],
					environment: "happy-dom",
				},
			},
			{
				plugins: [
					cloudflareTest(async () => ({
						wrangler: { configPath: "./wrangler.jsonc" },
						// No test may reach a real model: it costs money and needs
						// a Cloudflare login, which CI does not have. A test that
						// needs inference stubs env.AI instead.
						remoteBindings: false,
						miniflare: {
							bindings: {
								TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
							},
						},
					})),
				],
				test: {
					name: "worker",
					include: ["test/worker/**/*.test.ts"],
					setupFiles: ["./test/worker/setup.ts"],
				},
			},
		],
	},
});
