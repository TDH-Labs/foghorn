# Foghorn

Automated social-influence pipeline for a solo operator: profile voice/interests from own
chat + post history, pick platforms, track outperforming content, then
ideate → draft → **gate** → approve → publish → measure → learn.

Architecture transplants VibeHard's gate system (deterministic + LLM-judged gates,
fix loop, anti-tamper, hold queue). Reference codebase: `~/dev/drydock` (READ-ONLY).

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
- [ ] 1 ingestion (Beeper Desktop API + X/LinkedIn archives)
- [ ] 2 profiling · [ ] 3 platform selection + connectors · [ ] 4 research + dashboard
- [ ] 5 create + gates + approvals (shadow) · [ ] 6 publish (MVP, L1)
- [ ] 7 reply engine · [ ] 8 learn loop · [ ] 9 autonomy ramp

Plan of record: `~/.claude/plans/i-want-to-build-proud-minsky.md`
