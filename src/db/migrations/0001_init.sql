-- Foghorn core schema. Others' messages are quarantined: they exist ONLY in
-- messages(is_self=0) + leak_shingles, never in corpus_docs or any prompt.

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('beeper','x_archive','linkedin_export','manual')),
  config_json TEXT NOT NULL DEFAULT '{}',
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  sender_name TEXT,
  is_self INTEGER NOT NULL CHECK (is_self IN (0,1)),
  sent_at TEXT NOT NULL,
  text TEXT NOT NULL,
  pii_flags_json TEXT NOT NULL DEFAULT '[]',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_chat ON messages(chat_id, sent_at);
CREATE INDEX idx_messages_self ON messages(is_self);

CREATE TABLE leak_shingles (
  shingle_hash TEXT NOT NULL,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  is_self INTEGER NOT NULL,
  PRIMARY KEY (shingle_hash, message_id)
) WITHOUT ROWID;
CREATE INDEX idx_shingles_hash ON leak_shingles(shingle_hash);

CREATE TABLE corpus_docs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('post','message','article')),
  platform TEXT,
  external_id TEXT UNIQUE,
  text TEXT NOT NULL,
  posted_at TEXT,
  engagement_json TEXT NOT NULL DEFAULT '{}',
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE profiles (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('voice','interests','expertise','persona')),
  json TEXT NOT NULL,
  corpus_hash TEXT NOT NULL,
  built_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  active INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, version)
);

CREATE TABLE platform_scores (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  audience_alignment REAL, momentum REAL, trust_fit REAL, composite REAL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  scored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ratified INTEGER NOT NULL DEFAULT 0,
  ratified_at TEXT
);

CREATE TABLE watchlist_creators (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  niche_tag TEXT,
  baseline_json TEXT NOT NULL DEFAULT '{}',
  last_polled_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (platform, handle)
);

CREATE TABLE creator_posts (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES watchlist_creators(id),
  external_id TEXT NOT NULL UNIQUE,
  posted_at TEXT,
  text_snippet TEXT,
  url TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  zscore REAL,
  collected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE trend_cards (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  format TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','used','expired'))
);

CREATE TABLE ideas (
  id INTEGER PRIMARY KEY,
  trend_card_id INTEGER REFERENCES trend_cards(id),
  interest_tag TEXT,
  angle TEXT NOT NULL,
  brief TEXT NOT NULL,
  steering_hints_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  idea_id INTEGER REFERENCES ideas(id),
  platform TEXT NOT NULL,
  content_class TEXT NOT NULL,
  body_text TEXT NOT NULL,
  media_refs_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  canonical_bytes BLOB NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  parent_draft_id INTEGER REFERENCES drafts(id),
  status TEXT NOT NULL DEFAULT 'drafting',
  voice_score REAL, quality_score REAL, risk_score REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE gate_runs (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  draft_version INTEGER NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('fast','full')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  overall TEXT CHECK (overall IN ('pass','block','escalate','n/a')),
  sentinel_id INTEGER
);

CREATE TABLE gate_findings (
  id INTEGER PRIMARY KEY,
  gate_run_id INTEGER NOT NULL REFERENCES gate_runs(id),
  gate TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass','block','n/a','escalate')),
  tool TEXT, rule_id TEXT, severity TEXT, message TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE sentinels (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  draft_version INTEGER NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  mac TEXT NOT NULL,
  minted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_sentinels_draft ON sentinels(draft_id, draft_version);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  draft_version INTEGER NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('auto','telegram','dashboard')),
  risk_score REAL,
  nonce TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  telegram_message_id TEXT,
  decided_at TEXT,
  decision TEXT CHECK (decision IN ('approved','rejected','edited','expired')),
  decided_via TEXT,
  note TEXT
);

CREATE TABLE schedule (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  platform TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  jitter_s INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','firing','sent','failed','cancelled','held')),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE published_posts (
  id INTEGER PRIMARY KEY,
  schedule_id INTEGER NOT NULL REFERENCES schedule(id),
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  platform TEXT NOT NULL,
  external_post_id TEXT NOT NULL,
  url TEXT,
  published_at TEXT NOT NULL,
  deleted_at TEXT,
  delete_reason TEXT
);

CREATE TABLE metrics (
  id INTEGER PRIMARY KEY,
  published_post_id INTEGER NOT NULL REFERENCES published_posts(id),
  collected_at TEXT NOT NULL,
  impressions INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER,
  quotes INTEGER, clicks INTEGER, followers_delta INTEGER,
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (published_post_id, collected_at)
);

CREATE TABLE account_metrics (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  followers INTEGER, following INTEGER,
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (platform, snapshot_date)
);

CREATE TABLE spend_ledger (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  category TEXT NOT NULL CHECK (category IN ('x_write','x_read','x_own_read','llm','other')),
  provider TEXT, model TEXT,
  units REAL NOT NULL,
  unit_cost_usd REAL NOT NULL,
  cost_usd REAL NOT NULL,
  ref TEXT, note TEXT
);
CREATE INDEX idx_ledger_ts ON spend_ledger(category, ts);

CREATE TABLE spend_caps (
  cap_group TEXT PRIMARY KEY,
  monthly_cap_usd REAL NOT NULL,
  soft_pct REAL NOT NULL DEFAULT 0.7,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE unit_costs (
  key TEXT PRIMARY KEY,   -- e.g. 'x.write', 'llm.claude-opus-4-8.in_mtok'
  usd REAL NOT NULL,
  note TEXT
);

CREATE TABLE journal (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('draft','post','run','system')),
  ref_id TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  entry_json TEXT NOT NULL
);

CREATE TABLE inductions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('format','hook','time','topic','length')),
  hypothesis TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','adopted','retired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ratified_at TEXT
);

CREATE TABLE autonomy_state (
  platform TEXT NOT NULL,
  content_class TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 3),
  clean_streak INTEGER NOT NULL DEFAULT 0,
  total_approved INTEGER NOT NULL DEFAULT 0,
  total_rejected INTEGER NOT NULL DEFAULT 0,
  last_incident_at TEXT,
  cooldown_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (platform, content_class)
);

CREATE TABLE autonomy_events (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  content_class TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('promote','demote','incident','reset','ratify')),
  from_level INTEGER, to_level INTEGER,
  reason TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE holds (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER REFERENCES drafts(id),
  packet_json TEXT NOT NULL,
  specialty TEXT NOT NULL CHECK (specialty IN ('voice','claims','risk','platform','publish')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  resolution TEXT
);

CREATE TABLE banned_topics (
  id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('keyword','regex','topic')),
  reason TEXT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seeds: settings, caps, unit costs (config lives in the DB, not code, so an
-- X price change is a settings edit — reconciled weekly against real billing).
INSERT INTO settings (key, value) VALUES
  ('paused', '0'),
  ('max_autonomy_level', '1'),
  ('voice_threshold', '70'),
  ('quiet_hours', '23:00-07:00'),
  ('telegram_offset', '0');

INSERT INTO spend_caps (cap_group, monthly_cap_usd, soft_pct) VALUES
  ('x', 20.0, 0.7),
  ('llm', 150.0, 0.7),
  ('other', 10.0, 0.7);

INSERT INTO unit_costs (key, usd, note) VALUES
  ('x.write', 0.015, 'pay-per-use post create, verify vs console billing'),
  ('x.link_write', 0.20, 'post containing a URL'),
  ('x.read', 0.005, 'standard read'),
  ('x.own_read', 0.001, 'owned-data read'),
  ('llm.claude-opus-4-8.in_mtok', 5.0, 'per 1M input tokens'),
  ('llm.claude-opus-4-8.out_mtok', 25.0, 'per 1M output tokens'),
  ('llm.claude-haiku-4-5.in_mtok', 1.0, 'per 1M input tokens'),
  ('llm.claude-haiku-4-5.out_mtok', 5.0, 'per 1M output tokens'),
  ('llm.claude-sonnet-5.in_mtok', 3.0, 'per 1M input tokens (intro $2 to 2026-08-31)'),
  ('llm.claude-sonnet-5.out_mtok', 15.0, 'per 1M output tokens (intro $10)'),
  ('llm.default.in_mtok', 5.0, 'fallback when model unknown'),
  ('llm.default.out_mtok', 25.0, 'fallback when model unknown');
