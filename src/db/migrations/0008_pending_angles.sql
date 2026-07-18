-- Pending clarifying-question angles from ideate_propose_angle, persisted so
-- ideate_answer_question can resolve them later -- Hermes cron jobs run in a
-- fresh subprocess per invocation, so an in-memory Map does not survive from
-- "the morning digest asked a question" to "the operator answers hours later in a
-- separate conversation."
CREATE TABLE pending_angles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  idea_json TEXT NOT NULL,
  question TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_pending_angles_open ON pending_angles(resolved_at);
