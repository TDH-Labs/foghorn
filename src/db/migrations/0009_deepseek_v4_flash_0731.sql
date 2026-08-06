-- DeepSeek V4 Flash 0731 unit costs (confirmed against openrouter.ai 2026-08-06:
-- prompt $0.09/MTok, completion $0.18/MTok — matches the plain flash tier).
-- The trend scanner's web-search generation moved onto this model; cost rows
-- keep the spend ledger accurate.
INSERT INTO unit_costs (key, usd, note) VALUES
  ('llm.deepseek/deepseek-v4-flash-0731.in_mtok', 0.09, 'openrouter light tier default'),
  ('llm.deepseek/deepseek-v4-flash-0731.out_mtok', 0.18, 'openrouter light tier default');
