#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${VSCE_PAT:-}" ]]; then
  echo "VSCE_PAT is required. Set it in .env or environment." >&2
  exit 1
fi

npx @vscode/vsce publish "$@"
