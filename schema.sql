CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  messages TEXT -- JSON string array
);
CREATE INDEX IF NOT EXISTS idx_user_created ON conversations(user_id, created_at DESC);
