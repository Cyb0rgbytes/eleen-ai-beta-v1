-- Users' own provider API keys (M3.4 part two).
--
-- A premium model (OpenAI, Anthropic, Google, DeepSeek) runs only with the
-- caller's own key. Keys are stored AES-GCM encrypted under the Worker secret
-- KEY_ENCRYPTION_KEY (src/lib/keys.ts); the database never holds plaintext,
-- and the Worker never returns a key to a client or writes one to a log.
--
-- `key_version` names which master key encrypted the row, so the master key
-- can be rotated by re-encrypting rows rather than discarding them. `last4`
-- is the only fragment shown back to the user, to tell their keys apart.

CREATE TABLE provider_keys (
	user_id     TEXT    NOT NULL,
	provider    TEXT    NOT NULL, -- openai | anthropic | google | deepseek
	ciphertext  TEXT    NOT NULL, -- base64, AES-GCM with the 16-byte tag appended
	iv          TEXT    NOT NULL, -- base64, 12 random bytes, unique per row
	key_version INTEGER NOT NULL DEFAULT 1,
	last4       TEXT    NOT NULL,
	created_at  INTEGER NOT NULL, -- unix seconds
	verified_at INTEGER,          -- unix seconds of the last successful provider check
	PRIMARY KEY (user_id, provider)
) WITHOUT ROWID;
