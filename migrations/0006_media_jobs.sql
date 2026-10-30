-- Paid generation jobs for EleenAI Studio.
--
-- One row per job. The id is minted by the client as an idempotency key, so a
-- repeated request can't start a second billable job. Every read filters by
-- user_id. No foreign key to users: this is billing evidence and outlives the
-- account (0005_credits.sql). Times are unix milliseconds.
CREATE TABLE media_jobs (
	id           TEXT    PRIMARY KEY, -- UUID, also the credit ledger reference
	user_id      TEXT    NOT NULL,
	model        TEXT    NOT NULL,    -- registry id (src/media/registry.ts)
	prompt       TEXT    NOT NULL,
	status       TEXT    NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
	credits      INTEGER NOT NULL,
	cost_micros  INTEGER NOT NULL,    -- reserved provider cost, millionths of a dollar
	spend_day    TEXT    NOT NULL,    -- the studio_spend row the cost was reserved on
	request_id   TEXT,                -- fal's id, once submitted
	status_url   TEXT,
	response_url TEXT,
	r2_key       TEXT,                -- set on success
	created_at   INTEGER NOT NULL,
	finished_at  INTEGER
);

CREATE INDEX media_jobs_user ON media_jobs (user_id, created_at);
