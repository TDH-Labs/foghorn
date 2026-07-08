# Foghorn Dashboard

A local web GUI that orchestrates the full Foghorn pipeline. Built with a Bun HTTP server (no external deps) serving a vanilla-JS SPA.

## Quick Start

```bash
# From the foghorn project root:
npm run dashboard
# → opens API server at http://localhost:3009
```

Open **http://localhost:3009** in your browser.

## Views

| View | Route | What it does |
|------|-------|--------------|
| **Dashboard** | `/` | Live KPIs: corpus size, drafts, holds, spend levels, pause state |
| **Pipeline** | `#pipeline` | Kanban view of the full pipeline state, ingest controls |
| **Engine** | `#engine` | Run the content engine with real-time log streaming |
| **Approvals** | `#approvals` | Review & approve/reject drafts before posting |
| **Evidence** | `#evidence` | Manage the evidence bank: add, approve, extract |
| **Research** | `#research` | Scan trends, manage creator watchlist |
| **Profiles** | `#profiles` | Build & ratify voice profiles |
| **Platforms** | `#platforms` | Score platforms, manage API connectors, LinkedIn OAuth |
| **Settings** | `#settings` | Autonomy level, voice threshold, spend caps |
| **Automations** | `#automations` | One-click pipeline workflows (Setup, Content Cycle, Full) |

## Automation Workflows

- **Setup Pipeline** — connect → ingest → profile build → platform score → trend scan → evidence extract
- **Content Cycle** — ingest → scan → extract → run engine
- **Publish & Measure** — publish tick → collect X metrics
- **Full Pipeline** — Content Cycle → schedule approvals → Publish & Measure

All automation steps stream real-time logs into the UI via Server-Sent Events (SSE).

## API Surface

The server (`dashboard/server.ts`) exposes a REST API on port **3009**:

```
GET  /api/status                         Global health KPIs
GET  /api/settings                       All settings key-value pairs
POST /api/settings                       Upsert settings keys
POST /api/pause                          Pause the pipeline
POST /api/resume                         Resume (requires reason)
POST /api/spend/caps                     Update monthly spend caps { llm, x, other }
GET  /api/spend                          Current spend vs cap for llm/x/other
GET  /api/drafts                         All drafts
GET  /api/holds                          Open gate holds
POST /api/holds/:id/decide               Manually approve / reject a held draft escalation
GET  /api/approvals                      Drafts pending human decision
POST /api/approvals/:id/decide           Approve / reject / edit a draft
POST /api/engine          (SSE)          Run the content engine
POST /api/publish-tick    (SSE)          Fire publisher tick
POST /api/ingest/beeper                  Pull from Beeper
POST /api/ingest/archive                 Import X/LinkedIn archive { kind, path }
POST /api/platforms/score (SSE)          Run platform strategist
POST /api/platforms/linkedin/auth (SSE)  LinkedIn OAuth2 flow → opens tab, writes token
GET  /api/platforms/connectors           Validate all platform API credentials
POST /api/platforms/:platform/ratify     Set primary target platform
GET  /api/profiles                       List all voice profiles
POST /api/profiles/build  (SSE)          Build new profiles from corpus
POST /api/profiles/:version/ratify       Activate a profile version
GET  /api/trends                         Cached trend cards
POST /api/scan            (SSE)          Run trend scanner
GET  /api/evidence                       Evidence bank items
POST /api/evidence/extract (SSE)         Extract evidence from corpus
POST /api/evidence/:id/approve           Approve an evidence item
POST /api/evidence/:id/reject            Reject an evidence item
GET  /api/autonomy                       Autonomy ladder state
POST /api/autonomy/:p/:cc/ratify         Promote platform/content_class to next level
POST /api/automations/:workflow (SSE)    Run a named automation workflow
```

SSE endpoints stream `data: {...}\n\n` events with `type: "log" | "done" | "error"`.

## Architecture Notes

- **No framework** — pure Bun + vanilla JS ES modules
- **No build step** — browser loads JS modules directly
- **State** — all state lives in the SQLite DB (opened via a single module-level `openAndMigrate()` connection to support async SSE streams)
- **Safety** — killswitch (`isPaused()`) is checked at every automation entry point
- **SSE** — console.log/error is monkey-patched to broadcast to all open SSE subscribers
- **Sentinel** — the publisher only trusts sentinel-verified draft bytes; editing a draft in Approvals re-seals it before publishing
