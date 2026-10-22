-- Conversation history, branching, folders, consent and memory (M4.1).
--
-- Everything here belongs to one signed-in user. Every query MUST filter by
-- user_id, including the ones that also name a conversation or message id:
-- an id from the client is a claim, and checking ownership in the same WHERE
-- clause is what stops one user reading or changing another's rows (IDOR).
-- messages carries user_id itself, so a message can be checked without a join.
--
-- Guests have no rows here; their chat stays in the browser.
--
-- Times are unix milliseconds throughout, so ordering by time is exact and
-- matches Date.now() in the Worker.

-- One row per signed-in user, created on first use.
CREATE TABLE users (
	user_id      TEXT    PRIMARY KEY, -- Clerk user id
	created_at   INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL
);

-- What the user agreed to (M4.6). History is on and memory off until they
-- choose otherwise. policy_version is the privacy policy they accepted, so a
-- later policy change can ask again. No row means the dialog was never shown.
CREATE TABLE consents (
	user_id        TEXT    PRIMARY KEY REFERENCES users (user_id) ON DELETE CASCADE,
	history        INTEGER NOT NULL DEFAULT 1 CHECK (history IN (0, 1)),
	memory         INTEGER NOT NULL DEFAULT 0 CHECK (memory IN (0, 1)),
	policy_version INTEGER NOT NULL,
	updated_at     INTEGER NOT NULL
);

CREATE TABLE folders (
	id         TEXT    PRIMARY KEY, -- random UUID
	user_id    TEXT    NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
	name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
	position   INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX folders_user ON folders (user_id, position);

-- A conversation is a tree of messages. active_leaf_id is the message the
-- user is looking at; walking parent_id up from it gives the visible thread,
-- and it is the context the server rebuilds for the next turn. Deleting is
-- soft (deleted_at) so an accidental delete can be undone; a purge removes
-- the row, and its messages go with it.
CREATE TABLE conversations (
	id             TEXT    PRIMARY KEY, -- random UUID
	user_id        TEXT    NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
	folder_id      TEXT    REFERENCES folders (id) ON DELETE SET NULL,
	title          TEXT    NOT NULL DEFAULT '' CHECK (length(title) <= 200),
	pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
	active_leaf_id TEXT,  -- a messages.id in this conversation, or NULL when empty
	created_at     INTEGER NOT NULL,
	updated_at     INTEGER NOT NULL,
	deleted_at     INTEGER
);

-- The sidebar list: a user's live conversations, pinned first, newest first.
CREATE INDEX conversations_user ON conversations (user_id, deleted_at, pinned DESC, updated_at DESC);

-- One message per row. parent_id links a reply to the turn it answers and a
-- turn to the reply before it; siblings (same parent) are regenerations,
-- edits, or a compare_group of models answering side by side (M5.4).
--
-- seq orders messages within a conversation by creation (1, 2, 3...); it is
-- what the ‹2/3› navigator sorts siblings by. status is 'streaming' while a
-- reply is being written, then 'complete', 'stopped' or 'error'.
--
-- Kept with a rowid (not WITHOUT ROWID) so the full-text index can point at it.
CREATE TABLE messages (
	id                TEXT    PRIMARY KEY, -- random UUID
	conversation_id   TEXT    NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
	user_id           TEXT    NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
	parent_id         TEXT    REFERENCES messages (id) ON DELETE CASCADE,
	seq               INTEGER NOT NULL,
	role              TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
	content           TEXT    NOT NULL DEFAULT '',
	search_text       TEXT    NOT NULL DEFAULT '', -- content normalised for search; see messages_fts
	reasoning         TEXT,             -- a reasoning model's thinking, never sent back as context
	model             TEXT,             -- registry id that wrote an assistant message
	status            TEXT    NOT NULL DEFAULT 'complete'
	                  CHECK (status IN ('streaming', 'complete', 'stopped', 'error')),
	compare_group     TEXT,             -- shared by siblings answering one turn side by side
	completion_tokens INTEGER,
	created_at        INTEGER NOT NULL,
	UNIQUE (conversation_id, seq)
);

CREATE INDEX messages_parent ON messages (conversation_id, parent_id, seq);
CREATE INDEX messages_user ON messages (user_id, created_at);

-- Full-text search over messages (M4.4 sidebar search).
--
-- External-content FTS5 over messages.search_text: the index holds only
-- tokens and is kept in step by the triggers below. search_text is content
-- normalised by the Worker before every write (src/db: Arabic tashkeel and
-- tatweel stripped, alef forms unified), and a query is normalised the same
-- way, so a search without diacritics finds text written with them.
-- unicode61 with remove_diacritics 2 also folds Latin accents.
--
-- A search MUST join back to messages and filter by user_id:
--   SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
--   WHERE messages_fts MATCH ? AND m.user_id = ?
CREATE VIRTUAL TABLE messages_fts USING fts5 (
	search_text,
	content = 'messages',
	content_rowid = 'rowid',
	tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts (rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
	INSERT INTO messages_fts (messages_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF search_text ON messages BEGIN
	INSERT INTO messages_fts (messages_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
	INSERT INTO messages_fts (rowid, search_text) VALUES (new.rowid, new.search_text);
END;

-- Long-term memory (M4.6), only while consents.memory = 1. One fact per row,
-- each screened for injection before it is stored, so the user can see and
-- delete exactly what is remembered. Replaces the KV keys mem:v1:*.
CREATE TABLE memory_entries (
	id                TEXT    PRIMARY KEY, -- random UUID
	user_id           TEXT    NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
	fact              TEXT    NOT NULL CHECK (length(fact) BETWEEN 1 AND 500),
	source_message_id TEXT    REFERENCES messages (id) ON DELETE SET NULL,
	created_at        INTEGER NOT NULL
);

CREATE INDEX memory_entries_user ON memory_entries (user_id, created_at);
