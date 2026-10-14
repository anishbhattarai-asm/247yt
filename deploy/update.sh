#!/usr/bin/env bash
# Pull the latest code and restart. The stream flushes cleanly and resumes
# from where it was (YouTube keeps the broadcast if it's a scheduled stream
# with Auto-stop OFF).
#
#   bash deploy/update.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git pull --ff-only
npm ci --omit=dev --no-fund --no-audit >/dev/null
bash deploy/install-units.sh # new or changed systemd units
sudo systemctl restart stream-panel
echo "Updated and restarted. Logs: journalctl -u stream-panel -f"
