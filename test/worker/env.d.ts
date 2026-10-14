// Test-only bindings added by vitest.config.ts on top of the Worker's own Env.
declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		ELEEN_MEMORY: KVNamespace;
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}
