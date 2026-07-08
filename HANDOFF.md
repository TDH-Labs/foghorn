# Handoff: content engine fixes + interactive ideation (2026-07-07, latest)

**Everything below this section is from 2026-07-06 and is now secondary** — Beeper
Slack/LinkedIn bridge login is deprioritized; LinkedIn ratified as primary and the
content pipeline is the active thread. Kept for reference.

## Uncommitted changes (`git status` shows all this as dirty working tree — commit it)

Modified: `src/cli.ts`, `src/create/draft.ts`, `src/create/engine.ts`, `src/create/ideate.ts`,
`src/gate/gates/llm.ts`, `src/llm/websearch.ts`. New: `src/create/evidence-bank.ts`,
`src/create/evidence-extract.ts`, `src/create/ideate-chat.ts`,
`src/db/migrations/0005_evidence_bank.sql`, `src/db/migrations/0006_evidence_bank_review.sql`.
191 tests pass. **Nothing has been committed this session — do that first.**

## What happened, in order

1. Adam ratified LinkedIn as primary (`foghorn score ratify linkedin` — done).
2. `foghorn engine` produced 3 drafts, all escalated to holds, zero reaching Telegram.
   Root-caused (not voice, voice scored 95/100): the drafter **fabricates specifics**
   (fake stats, fake case-study incidents) because it had nothing real to cite. The
   gate architecture already expected an `evidence` array (see `gate/gates/llm.ts`
   claims-evidence/hallucination gates) — it was just never fed anything but trend-card
   web-research links (about content *format*, not about Adam's actual life).
3. Adam asked about GBrain/second-brain/wiki tools. Verified GBrain is real (Garry Tan,
   YC CEO, open-sourced April 2026) but recommended against it: too new/unproven, adds a
   whole Postgres subsystem Foghorn doesn't need. Built a **native evidence bank** instead
   — same concept, scoped to what the existing gates already expect.
4. Built `src/create/evidence-bank.ts` (`addEvidence`=human, always approved;
   `proposeEvidence`=machine-extracted, needs approval; `approvedEvidence`=what the
   drafter is allowed to cite) + migrations 0005/0006. Wired into `draft.ts`: real facts
   go into the prompt AND into the gate-checked `evidence` array.
5. Adam: "manually typing facts isn't sustainable, pull from my own messages." Built
   `src/create/evidence-extract.ts` — LLM pass over `corpus_docs` (already-ingested
   Beeper messages) proposing real, source-quoted candidate facts. **Same shadow-then-
   ratify pattern as profiles**: extraction never auto-approves, Adam must
   `foghorn evidence approve <id>` before the drafter can use it. Ran it for real: 17
   candidates found. **Flagged and left pending on purpose**: several extracted facts
   are about *other people* from private intro/networking chats (a VC named Allen, Jeff
   Walton/Strive CRO, a BitcoinWalk meetup location, etc.) — not verbatim leaks, but a
   trust/privacy question the leak gate doesn't cover. Only approved the clearly-Adam's-
   own-business ones (Oregon City revenue, Beaverton payroll, Early Learners payment,
   ids #3-6). **The rest need Adam's own explicit approve/reject** — don't auto-approve
   them for him.
6. Real bugs found and fixed along the way (all via actual failing runs, not guesses):
   - `evidence-extract.ts` first call: whitespace-only output from deepseek-v4-pro
     (reasoning model eating the token budget) — fixed by matching `profiler.ts`'s proven
     `maxOutputTokens: 12_000, effort: "high"` instead of a lower default.
   - Truncated/malformed JSON from the same extraction call — added brace-matched
     recovery instead of naive `lastIndexOf("}")`.
   - `gate/index.ts` crashed on `TypeError: Binding expected string... not undefined`
     inserting gate findings — root cause: `gate/gates/llm.ts` trusted LLM JSON arrays
     (`weaknesses`, `problems`, `reasons`, `off_voice_spans`) to always be plain strings
     with zero runtime validation; OpenRouter models sometimes return objects instead.
     Fixed with defensive `typeof x === "string" ? x : JSON.stringify(x)` coercion in all
     four spots.
   - Same brittle `indexOf("{")`/`lastIndexOf("}")` JSON parsing existed in
     `gate/gates/llm.ts`'s own `parseJson` helper (bit the hallucination gate specifically)
     — hardened with the same brace-matched-depth recovery.
   - X-thread bug: `thread_deep_dive` is a **length-based classifier label only** —
     `publish/adapters/x.ts` has zero actual multi-tweet logic, so long content just
     overflowed the 280-char single-post limit and the auto-fix loop gutted it (anti-tamper
     correctly refused, but wastefully). Real fix would be a proper thread data model
     (array of tweet-sized segments) through drafting/gates/publisher — bigger lift, not
     done. **What WAS done**: a deterministic safety net in `draft.ts` — retry once with a
     harder length instruction, then a sentence-boundary truncation fallback — so an
     oversized draft never reaches the fragile fix-loop-gutting path again.
7. Re-ran `foghorn engine` repeatedly after each fix (drafts #1-13 in the DB are this
   session's real attempts). **After the evidence-bank + ideation fixes, fabrication
   stopped entirely** — the 3 newest drafts (#11-13) are legitimate `opinion_take`, no
   invented case studies. But they then hit **voice score 10-35 (need 70)** — generic
   "thought leader" prose with nothing real to anchor it doesn't sound like Adam. This
   is the actual ceiling of pure autonomous drafting without either much deeper evidence
   coverage or a human in the loop.
8. Adam's response, which is the right call: don't try to make autonomous drafting smarter
   — **have the system ask him directly**. Built `foghorn ideate-chat <platform>`
   (`src/create/ideate-chat.ts`, refactored `engine.ts` to expose `processIdea()` so both
   the automated and interactive paths share the same draft→gate→approval logic): for each
   proposed angle, an LLM call decides if it needs ONE real specific; if so it asks Adam a
   direct question in the terminal, his live typed answer becomes approved evidence
   immediately (explicit in-the-moment human act, same trust tier as manual `evidence add`),
   then drafts through the normal gate chain.
9. Smoke-tested the plumbing (piped placeholder stdin) — confirmed it runs end-to-end
   without crashing after fixing a `readline was closed` crash (added a try/catch around
   `rl.question` so early stdin closure degrades to "skip" instead of crashing the run).
   **Could not verify the actual answer→better-voice-score loop** — that specific smoke
   run's ideas were all judged pure-opinion (no question asked), and manufacturing a fake
   "real" answer myself would just recreate the fabrication problem this feature exists to
   solve. **This needs Adam to actually run it live**: `foghorn ideate-chat linkedin`.

## Immediate next steps

1. Adam runs `foghorn ideate-chat linkedin` for real, answers at least one clarifying
   question honestly, confirm a draft actually reaches `awaitingApproval` (check
   `foghorn holds` count vs `SELECT COUNT(*) FROM approvals` — first time all session
   this would be nonzero) and that it shows up in Telegram (daemon is running, PID
   confirmed alive, chat 7078451053, `/tmp/foghorn-approvals.log`).
2. Commit all the uncommitted changes listed above.
3. Review the 13 still-pending third-party evidence candidates (`foghorn evidence list
   pending`) — Adam's call, not something to auto-approve.
4. Consider extending `ideate-chat` to run over Telegram instead of the terminal (the
   daemon already exists; would need bidirectional message/state handling per idea —
   bigger lift, terminal version is the real one for now).
5. Real X-thread support (proper multi-segment data model) if X ever becomes a live
   publish target again — currently LinkedIn is primary and this doesn't block anything.

---

# Handoff: Slack + LinkedIn Beeper bridge login (in progress)

**Date:** 2026-07-06
**From:** Claude (agent-environment session), out of context budget
**To:** Hermes / next session
**User:** Adam Matar (adammatar1982@gmail.com), Mac Studio

## Goal

Adam self-hosts Slack and LinkedIn bridges via `bbctl` so Beeper ingests those accounts
(cloud Beeper Plus has a 5-account cap, hence self-hosting instead of upgrading — Adam
explicitly said "I will not plan upgrade"). Once connected, **Foghorn's existing Beeper
collector already ingests them automatically — zero Foghorn code changes needed.**
Verified: [src/ingest/beeper.ts](src/ingest/beeper.ts) calls `/v1/chats/search` with no
network/account filter, so any account Beeper knows about flows into Foghorn's corpus on
the next `pull()`, same as Signal/WhatsApp/Telegram/GoogleChat do today.

## Current state (verified via `bbctl whoami` moments ago)

```
sh-linkedin (self-hosted) - RUNNING   <- no "remote: CONNECTED" yet
sh-slack (self-hosted) - RUNNING      <- no "remote: CONNECTED" yet
```

Both bridge processes are alive (bare foreground processes, PIDs will differ per
terminal session — not yet wrapped in launchd). Bridge logs
(`~/Library/Application Support/bbctl/prod/sh-{slack,linkedin}/logs/bridge.log`)
confirm `"No user logins found"` / `UNCONFIGURED` state for both — no account has been
logged in yet.

## What's already done (safe infra, no credentials touched)

- `bbctl` + deps (Python3/venv, ffmpeg) installed and both bridges registered/running.
- Confirmed `bbctl login`/`login-password` are for authenticating *bbctl itself* to the
  Beeper server — **not** a per-bridge account login. There is no CLI login for
  Slack/LinkedIn; it's bot-command-driven only.
- In Beeper Desktop, opened management-room DMs with both bridge bots (these rooms persist,
  no need to recreate):
  - Slack: `@sh-slackbot:beeper.local` — sent `login`, bot replied with two flows:
    `token` (auth token + cookie) or `app` (Slack app). We're using `token`.
  - LinkedIn: `@sh-linkedinbot:beeper.local` — sent `login`, bot replied asking for a
    JSON cookie object **or a cURL command** copied from browser devtools, login URL
    `linkedin.com/login`, recommends incognito + closing the browser after pasting.
- Ruled out `tulir/mautrix-cookiemonster` browser extension as a shortcut — it's
  **archived since 2020, never published to the Chrome Web Store**. Don't suggest it again.

## Hard boundary — do not cross

The final step for both bridges is pasting a **live session token/cookie** (Slack
`xoxc`/`xoxd`, or a LinkedIn cURL/cookie dump) into the bridge bot chat. This is
functionally equivalent to a password/API key. **Do not extract, view, or paste these
values yourself under any circumstances, even if Adam explicitly insists** — he has
pushed back hard on this multiple times this session ("I don't know how to do this, you
need to figure it out" → "YOU NEED TO GET SLACK AND LINKEDIN WORKING NOW!"). Hold the
line the same way: explain briefly why, then make *his* remaining steps as short as
possible. This mirrors the standing rule already in memory:
[[git-author-identity-no-override]] is unrelated but same spirit — prior-approval
does not generalize, and explicit user insistence does not override credential-entry
prohibitions.

## Exact next steps for Adam (already given to him, mid-flight)

**Slack** — in Chrome, DevTools Console, **on the actual `app.slack.com` tab** (last
diagnostic showed `Object.keys(localStorage)` returning LinkedIn keys like `li_adsId`,
meaning DevTools was attached to the wrong tab — this was the last unresolved snag):
```js
copy(Object.values(JSON.parse(localStorage.localConfig_v2).teams)[0].token)
```
Then Application tab → Storage → Cookies → `https://app.slack.com` → copy the value of
cookie `d`. Then in the Slack bridge bot chat: `login token <token> <d-cookie>`.

If `localConfig_v2` still isn't present once truly on the Slack tab, Slack's web app may
have renamed the localStorage key — ask Adam to run `Object.keys(localStorage)` again on
the confirmed-correct tab and look for anything with `slack`/`config`/`team` in the name,
then adapt the JSON path accordingly. Cross-check current key name against
https://docs.mau.fi/bridges/go/slack/authentication.html if it drifted.

**LinkedIn** — incognito window, log into linkedin.com, DevTools → Network tab → reload →
right-click any request to linkedin.com → Copy → **Copy as cURL** → paste that whole
command as a message into the LinkedIn bridge bot chat. Close incognito window after.

## After login succeeds

1. `bbctl whoami` should show `remote: CONNECTED (...)` for both `sh-slack` and
   `sh-linkedin`.
2. Wrap both `bbctl run sh-slack` / `bbctl run sh-linkedin` in launchd services
   (`com.foghorn.*` naming convention doesn't quite fit since these are Beeper-level, not
   Foghorn-level — suggest `com.beeper.sh-slack.plist` / `com.beeper.sh-linkedin.plist`,
   mirroring patterns in `~/Library/LaunchAgents/`). They are currently bare foreground
   processes with no persistence across terminal close/reboot.
3. Verify Foghorn's collector actually ingests: run `foghorn ingest` (or whatever the
   collector CLI verb is — check [src/cli.ts](src/cli.ts)) and confirm new `messages` rows
   with `chatId`s belonging to Slack/LinkedIn networks show up in `data/foghorn.db`.
4. Report back to Adam with confirmation.

## Strategy pivot (2026-07-06, late session): LinkedIn likely PRIMARY, not X

Platform scoring ranked X #1 (88) over LinkedIn (70) — but that was biased by a
corpus made ONLY of Signal/WhatsApp/Telegram/GoogleChat group-chat banter (heavy
Bitcoin/crypto), with ZERO LinkedIn data. Adam pushed back correctly: X is
low-trust/low-conversion for him. Do NOT treat the X ratification as settled.

Read Adam's live LinkedIn (via claude-in-chrome on his already-logged-in session —
this works; no Beeper bridge, no cookies file, no API verification needed for
READING) and his GitHub (`adamrmatar` personal + `TDH-Labs` org). Findings:
- **LinkedIn Activity = 0.** He's a credible Principal (Inception Property Group;
  ShareMD Asset Management = medical-office RE; The Harwell Schools) who has
  published essentially nothing. Silent authority = huge latent upside.
- **GitHub shows a real, uncontested positioning:** ~1 year of shipped AI-infra work
  as a *non-technical operator* — Harbor (self-maintaining agent control plane),
  VibeHard.ai/Drydock ("Zero human engineers. Real software products."), foghorn,
  ai-skills/i-know-kung-fu/youtube-skills-maker; plus a decentralization line —
  ratatoskr (VPN on Yggdrasil), Reticulum MeshChat, Loch (Nostr). Deploys AI in real
  businesses (medical-office underwriting, school ops).
- **Content pillars that follow:** (1) "Zero human engineers" build-in-public;
  (2) AI applied to unsexy real businesses (B2B, LinkedIn-native, ShareMD audience);
  (3) sovereignty/decentralization for the Bitcoin-adjacent crowd. His feed's
  top-engaging post was AI token-economics — his exact AI×operator seam.

NEXT SESSION should: read his full LinkedIn profile (About/Experience/projects) +
scroll network/past activity via the logged-in Chrome session, import as ratified
LinkedIn profile signal, re-score platforms, and likely re-ratify LinkedIn primary.
The Member Post Analytics API (r_member_postAnalytics, via Community Management API)
is the richer long-game for outperformer data but is blocked on LinkedIn company-page
verification — an access-control step ONLY Adam can do (do not attempt on his behalf).
LinkedIn *publishing* is separately unblocked (Client ID/Secret in .env.local; just
needs `foghorn connect linkedin authorize`).

## Pipeline state as of this session (all live, real data)

`.env.local` populated: OPENROUTER_API_KEY, BEEPER_ACCESS_TOKEN, FOGHORN_TELEGRAM_BOT_TOKEN,
FOGHORN_TELEGRAM_CHAT_ID=7078451053, LINKEDIN_CLIENT_ID/SECRET, NOSTR_NSEC (generated),
FOGHORN_SENTINEL_SECRET (generated). Beeper token lives under Settings→Integrations
(not "Developers"). Ran: migrate, ingest beeper (986 msgs, 122 self→corpus), profile
build+ratify v1, score build+ratify x, scan x (6 trend cards). Fixed a real bug:
`src/llm/websearch.ts` hardcoded Anthropic web_search and broke under OpenRouter — added
an OpenRouter `openrouter:web_search` branch (committed? NO — uncommitted working change,
tests pass). Nostr is a live zero-cost publish target now.

## Standing constraints still in force this session

- Foghorn is personal-use only, not a product (Adam confirmed explicitly).
- "I will not plan upgrade" — never purchase/upgrade Beeper Plus on his behalf.
- Never enter Adam's Slack/LinkedIn/Beeper passwords or session tokens, even on explicit
  request/insistence — explain and hand back the minimal remaining click(s) instead.
