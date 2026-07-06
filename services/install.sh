#!/usr/bin/env bash
# Render + load launchd services (com.foghorn.*). NOT run in Phase 0 —
# services go live per-phase (dashboard/approvals P5, publisher/metrics P6).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs/foghorn" "$DEST"

for tmpl in "$ROOT"/services/*.plist.template; do
  name="$(basename "$tmpl" .template)"
  sed -e "s|__FOGHORN_ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" "$tmpl" > "$DEST/$name"
  launchctl unload "$DEST/$name" 2>/dev/null || true
  launchctl load "$DEST/$name"
  echo "loaded $name"
done
