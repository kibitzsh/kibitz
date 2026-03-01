# Claude Instructions for Kibitz

VS Code extension + CLI that watches Claude/Codex sessions, generates live AI commentary, and dispatches prompts to existing or new agent sessions.

Distribution: **VS Code Marketplace** · **npm** · **Homebrew**

## Operator Preference (Mandatory)

- Assume approval for all non-destructive commands and proceed immediately.
- Do not ask for confirmation before running commands.
- Treat the user's default answer to permission prompts as **Yes**.

## Plan Mode

Always include **pros and cons** for every significant decision — stack choices, logic approaches, architectural trade-offs. Applies to all non-trivial decisions where alternatives exist.

## Keyboard Input

If user accidentally types Cyrillic characters (wrong keyboard layout), convert to English QWERTY equivalent:
- й→q, ц→w, у→e, к→r, е→t, н→y, г→u, ш→i, щ→o, з→p, ф→a, ы→s, в→d, а→f, п→g, р→h, о→j, л→k, д→l, я→z, ч→x, с→c, м→v, и→b, т→n, ь→m

## Shortcuts

### "c" — Commit and push (no build)

1. **TypeScript check** — `npm run typecheck`
2. **Run tests** — `npm run test:all`
3. **Git commit** — meaningful message
4. **Git push** — `git push origin master`

### "cd" — Commit, push, and build

1–4. Same as "c"
5. **Build** — `npm run build`
   - If build fails: fix and repeat from step 3

### "cr" — Commit, build, bump & release

1. **TypeScript check** — `npm run typecheck`
2. **Run tests** — `npm run test:all`
3. **Git commit** — one headline sentence (see release commit message rule below)
4. **Git push** — `git push origin master`
5. **Build** — `npm run build`
   - If build fails: fix and repeat from step 3
6. **Bump version** — update `version` in `package.json` (`patch` for fixes, `minor` for features)
7. **Version commit** — `git add package.json && git commit -m "chore: bump version to <VERSION>"`
8. **Tag** — `git tag v<VERSION>`
9. **Push with tag** — `git push origin master --tags`
10. **Publish VS Code extension** — `npm run publish:vscode`
11. **Publish npm** — `node scripts/publish-npm.js`
12. **Update Homebrew formula** — get SHA256 and update the tap:
    ```bash
    VERSION=$(node -p "require('./package.json').version")
    SHA=$(curl -sL "https://registry.npmjs.org/@kibitzsh/kibitz/-/kibitz-${VERSION}.tgz" | shasum -a 256 | awk '{print $1}')
    gh api repos/kibitzsh/homebrew-kibitz/contents/Formula/kibitz.rb \
      --jq '{sha: .sha, content: .content}' > /tmp/formula-meta.json
    CURRENT_SHA=$(cat /tmp/formula-meta.json | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])")
    curl -s "https://raw.githubusercontent.com/kibitzsh/homebrew-kibitz/main/Formula/kibitz.rb" \
      | sed "s/version \".*\"/version \"${VERSION}\"/" \
      | sed "s/sha256 \".*\"/sha256 \"${SHA}\"/" > /tmp/kibitz.rb.new
    gh api repos/kibitzsh/homebrew-kibitz/contents/Formula/kibitz.rb \
      -X PUT \
      -f message="chore: bump to v${VERSION}" \
      -f content="$(base64 < /tmp/kibitz.rb.new)" \
      -f sha="${CURRENT_SHA}"
    ```

**Release commit message**: One headline sentence about the most important change. Not a list — just the feature (e.g., "feat: codex session dispatch", "feat: commentary presets"). Bug fixes don't belong in the release message unless they're the whole point.

## Release Targets

Distribution is **not** via install scripts — users install through these channels:

| Channel | How |
|---------|-----|
| **VS Code Marketplace** | `npm run publish:vscode` (runs `vsce publish`) |
| **npm** | `npm publish` (publishes the CLI as `kibitz` binary) |
| **Homebrew** | Update the Homebrew tap formula with new version + SHA256 |

- No macOS `.pkg`, no Windows `.exe`, no Linux `.deb`
- No bundled Node.js runtime, no auto-update shell wrapper
- VS Code extension bundles its own deps via esbuild; CLI is a standalone Node script

## Tests

Tests are plain Node.js scripts in `scripts/`. No test framework — run directly.

```bash
npm run typecheck                   # TypeScript check (no emit)
npm run check:compat                # Build + compatibility check
npm run test:ui                     # Panel UI rendering tests
npm run test:parsers                # Cross-platform parser tests
npm run test:commentary             # Commentary assessment tests
npm run test:watcher                # Watcher session ID tests
npm run test:all                    # typecheck + check:compat + test:ui
```

### What each test covers

| Script | Scope |
|--------|-------|
| `test-panel-ui.js` | Panel HTML rendering, badge logic, session display |
| `test-parsers-cross-platform.js` | Claude + Codex JSONL parser correctness on mock data |
| `test-commentary-assessment.js` | Commentary assessment scoring, direction/security signals |
| `test-watcher-session-id.js` | Session ID extraction and deduplication |
| `check-compat.js` | API surface compatibility after build |

### Test rule on commit

- Run `npm run typecheck` on every commit.
- Run `npm run test:all` before pushing.
- If a test breaks, fix it — don't skip or comment it out.

## Build

```bash
npm run build           # Full build: core + extension + vscode-launcher + CLI
npm run build:core      # Core modules only (watcher, commentary, etc.)
npm run build:ext       # VS Code extension bundle → dist/vscode/extension.js
npm run build:cli       # CLI bundle → dist/cli/index.js
npm run watch           # Watch mode for extension (dev)
npm run package         # vsce package → .vsix file
```

Output structure:
```
dist/
├── core/           # watcher.js, commentary.js, platform-support.js, session-dispatch.js
├── vscode/
│   ├── extension.js
│   └── interactive-launcher.js
└── cli/
    └── index.js    # kibitz binary
```

## Project Structure

```
kibitz/
├── src/
│   ├── core/
│   │   ├── watcher.ts          # JSONL file watcher, session tracking
│   │   ├── commentary.ts       # LLM commentary engine, prompts, assessment
│   │   ├── session-dispatch.ts # Prompt dispatch to Claude/Codex sessions
│   │   ├── platform-support.ts # OS-specific paths, CLI detection
│   │   ├── types.ts            # Shared types
│   │   └── providers/
│   │       ├── anthropic.ts    # Claude CLI provider
│   │       └── openai.ts       # Codex CLI provider
│   │   └── parsers/
│   │       ├── claude.ts       # Claude JSONL event parser
│   │       └── codex.ts        # Codex JSONL event parser
│   ├── vscode/
│   │   ├── extension.ts        # VS Code extension entry point
│   │   ├── panel.ts            # Webview panel rendering
│   │   ├── persistence.ts      # Settings/state persistence
│   │   └── interactive-launcher.ts
│   └── cli/
│       └── index.ts            # Terminal CLI entry point
├── scripts/                    # Node.js test + dev scripts
├── media/                      # Icons, logos
├── dist/                       # Build output (gitignored)
└── package.json
```

## Tech Stack

- **Language**: TypeScript, strict mode
- **Bundler**: esbuild (CJS output, Node 18 target)
- **VS Code API**: `^1.85.0`
- **LLM Commentary**: Claude CLI (`claude -p`) and Codex CLI (`codex`)
- **Tests**: Plain Node.js scripts (no framework)
- **Packaging**: `vsce` for VS Code Marketplace, standard `npm publish` for CLI

## Git Setup

- Remote: `https://github.com/kibitzsh/kibitz.git`
- Branch: `master`
- Push with: `git push origin master`
- **Always typecheck before committing**: `npm run typecheck`

## VS Code Marketplace Deployment

```bash
npm run deploy:vscode   # Local smoke deploy to ~/.vscode/extensions and ~/.cursor/extensions
npm run package         # → kibitz-x.x.x.vsix
npm run publish:vscode  # Publish to marketplace (requires PAT in VSCE_PAT env)
```

For one-command guarded release flow (checks, publish verification, npm, Homebrew, push/tags):

```bash
npm run cr
```

- Publisher: `kibitzsh`
- Extension ID: `kibitzsh.kibitz`
- Icon: `media/icon.png` (must be ≥128×128 PNG)

## npm Publishing

```bash
npm publish             # Publishes CLI binary
```

- Package name: `kibitz`
- Entry bin: `dist/cli/index.js` (as `kibitz` command)
- Ensure `dist/` is built before publishing

## Homebrew

- Update the Homebrew tap formula (`kibitzsh/homebrew-kibitz`) with the new version and SHA256 of the npm tarball or GitHub release archive.
- Formula installs the CLI only (not the VS Code extension).
