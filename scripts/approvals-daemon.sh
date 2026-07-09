#!/bin/bash
# Long-running Telegram approvals loop: bun foghorn.ts approvals-daemon.
# Previously a bare, unsupervised foreground process; this script + the
# matching launchd plist give it KeepAlive supervision.
set -euo pipefail
cd "$(dirname "$0")/.."
exec /Users/ai/.bun/bin/bun foghorn.ts approvals-daemon
