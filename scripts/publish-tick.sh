#!/bin/bash
# Runs the actual send path: bun foghorn.ts publish-tick. Deterministic — only
# sends already gate-passed + approved + sentinel-valid rows whose scheduled
# time is due. Not agent-callable; only this launchd timer and the CLI can
# trigger it. See ~/rooms/foghorn/room_rules.md.
set -euo pipefail
cd "$(dirname "$0")/.."
exec /Users/ai/.bun/bin/bun foghorn.ts publish-tick
