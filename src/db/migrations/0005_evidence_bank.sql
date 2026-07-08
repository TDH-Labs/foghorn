-- Evidence bank: real, Adam-approved facts/numbers/anecdotes the drafter can
-- cite instead of inventing specifics. Populated via `foghorn evidence add`.
CREATE TABLE evidence_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  fact TEXT NOT NULL,
  added_at TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);

CREATE INDEX idx_evidence_bank_topic ON evidence_bank(topic);
