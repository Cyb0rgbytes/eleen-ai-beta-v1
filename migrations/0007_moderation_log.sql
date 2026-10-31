-- Prompts Studio refused, kept for review and abuse reports. Rows are removed
-- after 90 days by the daily cron, as the privacy page says. No foreign key to
-- users: this has to survive the account within those 90 days. Times are unix
-- milliseconds.
CREATE TABLE moderation_log (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id    TEXT    NOT NULL,
	prompt     TEXT    NOT NULL,
	reason     TEXT    NOT NULL,
	source     TEXT    NOT NULL CHECK (source IN ('rules', 'ai')),
	created_at INTEGER NOT NULL
);

CREATE INDEX moderation_log_created ON moderation_log (created_at);
