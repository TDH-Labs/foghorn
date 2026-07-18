# Foghorn

Automated social-influence pipeline for a solo operator: profile voice/interests from own
chat + post history, pick platforms, track outperforming content, then
ideate → draft → **gate** → approve → publish → measure → learn.

Architecture transplants VibeHard's gate system (deterministic + LLM-judged gates,
fix loop, anti-tamper, hold queue).

## The invariant

**Zero LLM calls in the send path.** The gate chain freezes exact bytes under an HMAC
sentinel; approval authorizes a frozen artifact; the publisher recomputes the hash of the
bytes it is about to send and refuses on any mismatch. Enforced structurally by
`tests/no-llm-in-publish.test.ts` (import-graph walk).

## Layout

- `src/` — flat domain modules (gate/, fixloop/, publish/, ingest/, …); tests co-located
- `data/` — SQLite (WAL) + `PAUSED` kill-switch flag (gitignored)
- `fixtures/bad-posts/` — gate regression corpus (bad + corrected twins)
- `services/` — launchd plist templates (`com.foghorn.*`)
- `dashboard/` — Next.js control panel, port 3009 (Phase 4)

## Commands

```
bun run foghorn.ts init          # migrate DB, seed settings/caps
bun run foghorn.ts status        # health, spend month-to-date, paused state
bun run foghorn.ts pause|resume  # kill switch (also via Telegram 'pause')
bun test                         # unit + structural tests
```

## Phase status

- [x] 0 scaffold + rails (schema, ledger, LLM layer, gate runner, sentinel, publisher core)
- [x] 1 ingestion (Beeper Desktop API + X/LinkedIn archive importers)
- [x] 2 profiling (voiceprint + versioned LLM profiles, human-ratified)
- [x] 3 platform selection + validate-on-connect connectors (X OAuth1, LinkedIn, Nostr, Telegram, Beeper)
- [x] 4 research (watchlist baselines, robust z-score outperformers, web-search trend scanner)
- [x] 5 create + 13 gates + fix loop/anti-tamper + Telegram approvals + bad-posts corpus
- [x] 6 publish (X/Nostr/LinkedIn adapters, L2 auto path risk<40+linkless, undo, X metrics)
      — code-complete; live e2e (Nostr relay → burner X → real L1) blocked on credentials
- [x] 7 reply engine (X mentions collector, ack/value_add/boundary/no_reply triage, anti-pile-on + rate-limit gate, reuses full gate/ladder/approval stack)
- [x] OpenRouter as an alternate LLM provider (DeepSeek V4-Pro/Flash default, GLM-5.2 alternate; `FOGHORN_LLM_PROVIDER` or auto-detect)
- [ ] dashboard (queue/trends/ladder/spend UI) · [ ] 8 learn loop + weekly report · [ ] 9 autonomy ramp

## Reference

- Privacy policy (for LinkedIn app registration's required field): [PRIVACY.md](PRIVACY.md)

## Onboarding (user actions before first live run)

1. Install Beeper Desktop, sign in, Settings → Developers → token into `.env.local` (`BEEPER_ACCESS_TOKEN`)
2. Request X archive + LinkedIn data export (24–48h) → `foghorn ingest x-archive/linkedin <zip>`
3. X developer account (pay-per-use) → 4 keys into `.env.local`
4. LinkedIn app + "Share on LinkedIn" product + OAuth grant → `LINKEDIN_*` + `LINKEDIN_ACCESS_TOKEN`
5. BotFather bot → `FOGHORN_TELEGRAM_BOT_TOKEN` and `FOGHORN_TELEGRAM_CHAT_ID`
6. `foghorn connect all` until green → `profile build` → `profile ratify` → `score build` → `score ratify`
7. `services/install.sh` to load launchd jobs; shadow week at L0; then L1
