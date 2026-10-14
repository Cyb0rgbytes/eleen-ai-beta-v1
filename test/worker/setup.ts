/**
 * Runs before each worker-project test file. Storage is isolated per file, so
 * every file starts from a freshly migrated, empty D1.
 */
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
