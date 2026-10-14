-- Usage counters for rate limiting (M3.3).
--
-- Replaces the KV counters in src/lib/ratelimit.ts. KV is eventually
-- consistent, so concurrent requests could each read the same count and all
-- be allowed; an upsert here is atomic:
--
--   INSERT INTO usage_counters (key, window_start, units, expires_at)
--   VALUES (?, ?, ?, ?)
--   ON CONFLICT (key, window_start) DO UPDATE SET units = units + excluded.units
--   RETURNING units;
--
-- `key` is already namespaced by bucket and caller (user ID, or a hashed IP
-- for guests), so no raw address is stored. `units` rather than a request
-- count, so an expensive model can cost more than one.

CREATE TABLE usage_counters (
	key          TEXT    NOT NULL,
	window_start INTEGER NOT NULL, -- unix seconds
	units        INTEGER NOT NULL DEFAULT 0,
	expires_at   INTEGER NOT NULL, -- unix seconds; rows past this are pruned
	PRIMARY KEY (key, window_start)
) WITHOUT ROWID;

CREATE INDEX usage_counters_expires_at ON usage_counters (expires_at);
