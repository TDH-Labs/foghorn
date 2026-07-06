-- Phase 4: web-search unit cost for the trend scanner's ledger entries.
INSERT INTO unit_costs (key, usd, note) VALUES
  ('llm.web_search.per_search', 0.01, 'Anthropic server-side web_search, per search executed');
