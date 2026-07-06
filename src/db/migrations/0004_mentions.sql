-- Phase 7: reply engine. reply_draft_id links a triaged mention to the draft
-- created for it, once triage decides ack/value_add/boundary warrant a reply.
CREATE TABLE mentions (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  author_handle TEXT,
  text TEXT NOT NULL,
  posted_at TEXT,
  triage TEXT CHECK (triage IN ('ack','value_add','boundary','no_reply')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','skipped','drafted','held')),
  reply_draft_id INTEGER REFERENCES drafts(id),
  collected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (platform, external_id)
);
CREATE INDEX idx_mentions_thread ON mentions(platform, thread_key);

INSERT INTO settings (key, value) VALUES ('max_replies_per_hour', '10');
