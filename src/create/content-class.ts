// Deterministic content classifier — the autonomy ladder is keyed on
// (platform, content_class), so classification must be reproducible and
// human-inspectable, never model-judged.

import type { ContentClass } from "../types.ts";

export function classifyContent(body: string, opts: { fromTrendCard?: boolean; isReply?: boolean } = {}): ContentClass {
  if (opts.isReply) {
    if (body.length <= 80) return "reply_ack";
    return "reply_value_add";
  }
  if (/https?:\/\//.test(body)) return "link_share";
  if (body.length > 800 || /\n\s*1[.)]\s/.test(body)) return "thread_deep_dive";
  if (/^(how to|tip:|\d+\s+(ways|lessons|things|rules|mistakes))/i.test(body.trim()) || /\bhere's how\b/i.test(body)) {
    return "evergreen_tip";
  }
  if (/^(today i|last (week|month|year)|when i|i (just|once|spent|shipped|built|learned))/i.test(body.trim())) {
    return "personal_story";
  }
  if (opts.fromTrendCard) return "trend_take";
  return "opinion_take";
}
