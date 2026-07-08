-- Add unit cost mapping for deepseek/deepseek-chat on OpenRouter
INSERT OR IGNORE INTO unit_costs (key, usd, note) VALUES
  ('llm.deepseek/deepseek-chat.in_mtok', 0.14, 'openrouter deepseek-chat input rate'),
  ('llm.deepseek/deepseek-chat.out_mtok', 0.28, 'openrouter deepseek-chat output rate');
