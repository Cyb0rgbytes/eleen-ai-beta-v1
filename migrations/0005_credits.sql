-- Prepaid credits for EleenAI Studio.
--
-- credit_ledger is the record of what happened and is append-only: triggers
-- refuse every UPDATE and DELETE. credit_balance is what the ledger adds up
-- to, kept in step by a trigger, so one INSERT moves both and neither can be
-- written without the other. Every query goes through src/lib/credits.ts.
--
-- None of these tables has a foreign key to users: they are financial records
-- and must outlive the account, so ON DELETE CASCADE would be wrong here.
--
-- Times are unix milliseconds, matching Date.now() in the Worker.

CREATE TABLE credit_balance (
	user_id    TEXT    PRIMARY KEY, -- Clerk user id
	balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
	expires_at INTEGER,             -- NULL until the first credits with an expiry
	shortfall  INTEGER NOT NULL DEFAULT 0 CHECK (shortfall >= 0), -- refunded credits already spent; above 0 blocks new holds
	updated_at INTEGER NOT NULL
);

CREATE TABLE credit_ledger (
	seq           INTEGER PRIMARY KEY AUTOINCREMENT, -- the order things happened
	user_id       TEXT    NOT NULL,
	kind          TEXT    NOT NULL CHECK (kind IN ('purchase', 'grant', 'hold', 'charge', 'release', 'refund', 'chargeback', 'expire')),
	delta         INTEGER NOT NULL,
	balance_after INTEGER NOT NULL,
	reference     TEXT    NOT NULL, -- a job id, order id or grant id
	expires_at    INTEGER,          -- credits added here last until at least this time
	shortfall     INTEGER NOT NULL DEFAULT 0, -- what a reversal could not take back
	created_at    INTEGER NOT NULL,
	-- Each thing happens once per reference, so a replay inserts nothing.
	UNIQUE (reference, kind)
);

-- A hold ends one way: charged or released, never both.
CREATE UNIQUE INDEX credit_ledger_terminal ON credit_ledger (reference) WHERE kind IN ('charge', 'release');

CREATE INDEX credit_ledger_user ON credit_ledger (user_id, seq);

CREATE TRIGGER credit_ledger_apply AFTER INSERT ON credit_ledger BEGIN
	UPDATE credit_balance
	SET balance = balance + NEW.delta,
		expires_at = CASE
			WHEN NEW.expires_at IS NULL THEN expires_at
			ELSE MAX(COALESCE(expires_at, 0), NEW.expires_at)
		END,
		shortfall = shortfall + NEW.shortfall,
		updated_at = NEW.created_at
	WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger BEGIN
	SELECT RAISE(ABORT, 'credit_ledger is append-only');
END;

CREATE TRIGGER credit_ledger_no_delete BEFORE DELETE ON credit_ledger BEGIN
	SELECT RAISE(ABORT, 'credit_ledger is append-only');
END;

-- An order from checkout. Created by the server before the customer pays, so
-- the user and amount credited come from here and not from the provider's
-- webhook metadata.
CREATE TABLE purchases (
	id          TEXT    PRIMARY KEY, -- random UUID, also the ledger reference
	user_id     TEXT    NOT NULL,
	provider    TEXT    NOT NULL,
	product     TEXT    NOT NULL,
	credits     INTEGER NOT NULL CHECK (credits > 0),
	amount      INTEGER NOT NULL, -- minor units of currency
	currency    TEXT    NOT NULL,
	status      TEXT    NOT NULL CHECK (status IN ('pending', 'paid', 'refunded', 'chargeback')),
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL
);

CREATE INDEX purchases_user ON purchases (user_id, created_at);

-- Provider webhook deliveries that were handled, as a record for support. Not
-- what stops a replay: that is the ledger, so a crash partway through a
-- delivery can't mark it done and lose the customer's credits.
CREATE TABLE payment_events (
	provider    TEXT    NOT NULL,
	event_id    TEXT    NOT NULL,
	received_at INTEGER NOT NULL,
	PRIMARY KEY (provider, event_id)
);

-- Who confirmed 18+ and accepted which terms, and when. Rows are only ever
-- added, because this is evidence: consents overwrites its row, so it can't be.
CREATE TABLE studio_acceptances (
	seq           INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id       TEXT    NOT NULL,
	terms_version INTEGER NOT NULL,
	accepted_at   INTEGER NOT NULL
);

CREATE INDEX studio_acceptances_user ON studio_acceptances (user_id, terms_version);

-- What Studio has committed to spend at providers on one UTC day, in millionths
-- of a dollar. The ceiling that holds even where AI Gateway can't see the cost
-- (src/lib/spend.ts).
CREATE TABLE studio_spend (
	day    TEXT    PRIMARY KEY, -- YYYY-MM-DD
	micros INTEGER NOT NULL CHECK (micros >= 0)
);
