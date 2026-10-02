#!/bin/bash
# Publish https://kibitz.sh/ — the site is served from the shared server, not from GitHub Pages
# (moved 2026-10-02). Run after the change is merged.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
HOST="${SITE_HOST:-appadmin@49.13.88.157}"
KEY="${SITE_KEY:-$HOME/.ssh/tracker-heroku-exit}"
DEST="/opt/selectic-heroku-exit/sites/kibitz.sh/"
rsync -az --delete --exclude CNAME -e "ssh -i $KEY -o BatchMode=yes" site/ "$HOST:$DEST"
echo "published: https://kibitz.sh/"
