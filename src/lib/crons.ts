/**
 * The Worker's cron triggers. Must match triggers.crons in wrangler.jsonc.
 *
 * These can't live in src/index.ts: workerd treats every export of the main
 * module as an entrypoint, and an exported string stops the Worker starting.
 */
export const SWEEP_CRON = "*/5 * * * *";
export const PURGE_CRON = "17 3 * * *";
