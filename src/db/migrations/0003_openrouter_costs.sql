-- OpenRouter unit costs. Confirmed against openrouter.ai model pages 2026-07-06
-- -- re-verify before trusting long term, marketplace pricing shifts.
INSERT INTO unit_costs (key, usd, note) VALUES
  ('llm.deepseek/deepseek-v4-pro.in_mtok', 0.435, 'openrouter reason tier default'),
  ('llm.deepseek/deepseek-v4-pro.out_mtok', 0.87, 'openrouter reason tier default'),
  ('llm.deepseek/deepseek-v4-flash.in_mtok', 0.09, 'openrouter light tier default (paid -- :free variant was pulled)'),
  ('llm.deepseek/deepseek-v4-flash.out_mtok', 0.18, 'openrouter light tier default'),
  ('llm.z-ai/glm-5.2.in_mtok', 0.56, 'openrouter reason-tier alternate, balanced routing'),
  ('llm.z-ai/glm-5.2.out_mtok', 1.76, 'openrouter reason-tier alternate, balanced routing');
