#!/usr/bin/env bash
set -euo pipefail

# Full "cr" release flow:
# - checks + build
# - publish VS Code Marketplace and verify version
# - publish npm and verify version
# - update Homebrew formula with npm tarball SHA
# - push commits + tags

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_BUMP=0
SKIP_PUSH=0
SKIP_VSCODE=0
SKIP_NPM=0
SKIP_BREW=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-bump) SKIP_BUMP=1 ;;
    --skip-push) SKIP_PUSH=1 ;;
    --skip-vscode) SKIP_VSCODE=1 ;;
    --skip-npm) SKIP_NPM=1 ;;
    --skip-brew) SKIP_BREW=1 ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

run() {
  echo "→ $*"
  "$@"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

read_pkg_version() {
  node -p "require('./package.json').version"
}

wait_for_marketplace_version() {
  local expected="$1"
  local current=""
  local attempt=0
  local max_attempts=24
  while [[ $attempt -lt $max_attempts ]]; do
    current="$(npx --yes @vscode/vsce show kibitzsh.kibitz --json | jq -r '.versions[0].version')"
    if [[ "$current" == "$expected" ]]; then
      echo "$current"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  echo "$current"
  return 1
}

wait_for_npm_latest() {
  local expected="$1"
  local current=""
  local attempt=0
  local max_attempts=24
  while [[ $attempt -lt $max_attempts ]]; do
    current="$(npm dist-tag ls @kibitzsh/kibitz | awk '/^latest:/{print $2}')"
    if [[ "$current" == "$expected" ]]; then
      echo "$current"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  echo "$current"
  return 1
}

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree must be clean before running cr release flow." >&2
  exit 1
fi

need_cmd node
need_cmd npm
need_cmd git
need_cmd jq
need_cmd gh
need_cmd curl
need_cmd shasum
need_cmd base64
need_cmd python3

run npm run typecheck
run npm run test:all
run npm run build

if [[ "$SKIP_BUMP" -eq 0 ]]; then
  run npm version patch --no-git-tag-version
fi

VERSION="$(read_pkg_version)"
TAG="v${VERSION}"

run git add package.json package-lock.json
if ! git diff --cached --quiet; then
  run git commit -m "chore: bump version to ${VERSION}"
fi

if git rev-parse --verify "$TAG" >/dev/null 2>&1; then
  echo "Tag ${TAG} already exists; reusing it."
else
  run git tag "$TAG"
fi

if [[ "$SKIP_VSCODE" -eq 0 ]]; then
  if [[ -z "${VSCE_PAT:-}" ]]; then
    echo "VSCE_PAT is required for Marketplace publish (or pass --skip-vscode)." >&2
    exit 1
  fi
  run npm run publish:vscode
  MARKETPLACE_VERSION="$(wait_for_marketplace_version "$VERSION" || true)"
  if [[ "$MARKETPLACE_VERSION" != "$VERSION" ]]; then
    echo "Marketplace version mismatch: expected ${VERSION}, got ${MARKETPLACE_VERSION}" >&2
    exit 1
  fi
  echo "✓ Marketplace version is ${MARKETPLACE_VERSION}"
fi

if [[ "$SKIP_NPM" -eq 0 ]]; then
  run npm run publish:npm
  NPM_VERSION="$(wait_for_npm_latest "$VERSION" || true)"
  if [[ "$NPM_VERSION" != "$VERSION" ]]; then
    echo "npm dist-tag mismatch: expected latest=${VERSION}, got latest=${NPM_VERSION}" >&2
    exit 1
  fi
  echo "✓ npm latest dist-tag is ${NPM_VERSION}"
fi

if [[ "$SKIP_BREW" -eq 0 ]]; then
  TARBALL_URL="https://registry.npmjs.org/@kibitzsh/kibitz/-/kibitz-${VERSION}.tgz"
  SHA="$(curl -sL "$TARBALL_URL" | shasum -a 256 | awk '{print $1}')"

  META_JSON="$(gh api repos/kibitzsh/homebrew-kibitz/contents/Formula/kibitz.rb)"
  FORMULA_SHA="$(printf '%s' "$META_JSON" | jq -r '.sha')"
  FORMULA_CONTENT_B64="$(printf '%s' "$META_JSON" | jq -r '.content' | tr -d '\n')"

  TMP_ORIG="$(mktemp)"
  TMP_NEW="$(mktemp)"
  python3 - "$FORMULA_CONTENT_B64" "$TMP_ORIG" <<'PY'
import base64
import sys
data = base64.b64decode(sys.argv[1])
with open(sys.argv[2], "wb") as f:
    f.write(data)
PY

  # Formula carries version in the tarball URL; update URL + SHA atomically.
  sed -E \
    -e "s|(url \"https://registry\\.npmjs\\.org/@kibitzsh/kibitz/-/kibitz-)[0-9]+\\.[0-9]+\\.[0-9]+(\\.tgz\")|\\1${VERSION}\\2|" \
    -e "s|(sha256 \")[0-9a-f]+(\")|\\1${SHA}\\2|" \
    "$TMP_ORIG" > "$TMP_NEW"

  if ! rg -q "kibitz-${VERSION}\\.tgz" "$TMP_NEW"; then
    echo "Failed to update Homebrew formula URL to ${VERSION}" >&2
    exit 1
  fi
  if ! rg -q "$SHA" "$TMP_NEW"; then
    echo "Failed to update Homebrew formula SHA to ${SHA}" >&2
    exit 1
  fi

  NEW_CONTENT_B64="$(base64 < "$TMP_NEW" | tr -d '\n')"
  run gh api repos/kibitzsh/homebrew-kibitz/contents/Formula/kibitz.rb \
    -X PUT \
    -f message="chore: bump to v${VERSION}" \
    -f content="$NEW_CONTENT_B64" \
    -f sha="$FORMULA_SHA"

  REMOTE_FORMULA="$(curl -sL https://raw.githubusercontent.com/kibitzsh/homebrew-kibitz/main/Formula/kibitz.rb)"
  if ! printf '%s' "$REMOTE_FORMULA" | rg -q "kibitz-${VERSION}\\.tgz"; then
    echo "Homebrew formula verification failed for version ${VERSION}" >&2
    exit 1
  fi
  if ! printf '%s' "$REMOTE_FORMULA" | rg -q "$SHA"; then
    echo "Homebrew formula verification failed for SHA ${SHA}" >&2
    exit 1
  fi
  echo "✓ Homebrew formula updated to ${VERSION}"
fi

if [[ "$SKIP_PUSH" -eq 0 ]]; then
  run git push origin master
  run git push origin master --tags
fi

echo "Release flow completed for ${VERSION}"
