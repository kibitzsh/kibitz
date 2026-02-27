# Kibitz

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Pages](https://github.com/kibitzsh/kibitz/actions/workflows/pages.yml/badge.svg)](https://github.com/kibitzsh/kibitz/actions/workflows/pages.yml)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fkibitz.sh)](https://kibitz.sh)

Kibitz is a VS Code extension + CLI that watches Claude/Codex sessions, generates live commentary, and lets you dispatch prompts to existing or new sessions from one composer.

## Compatibility Matrix (Contract)

| Platform | VS Code panel | Terminal CLI |
| --- | --- | --- |
| macOS | Supported | Supported |
| Windows | Supported | Supported |
| Linux | Best effort | Best effort |

## Core Capabilities

- Live commentary feed for Claude Code and Codex sessions.
- Cross-session prompt dispatch:
  - Existing active sessions.
  - New session on current provider.
- Slash controls in composer:
  - `/help`, `/pause`, `/resume`, `/clear`, `/focus`, `/model`, `/preset`
  - session targeting like `/1`, `/2`
- Provider-aware model handling.
- Strict dispatch status events: `queued`, `started`, `sent`, `failed`.

## Prompt Dispatching

Kibitz can send prompts to any active watched session (Claude or Codex), or start a new session on the current provider.

### VS Code Panel

- Target badges always include:
  - `/1 New session (current provider)`
  - `/2..N` existing active sessions from the watcher list
- Starting a new terminal session is one step: select `/1` and send your prompt.
- Select a target by:
  - clicking a target badge
  - typing `/N` (select only)
  - typing `/N <prompt>` or `N/ <prompt>` (select + send)
- Plain text (without target token) sends to the currently selected target.
- Each send emits explicit status updates: `queued`, `started`, `sent`, `failed`.

### Terminal CLI

- Use `/sessions` to list active sessions with numeric indexes.
- Set target with `/target <index|agent:sessionId|new-codex|new-claude>`.
- Starting a new terminal session is one command: `/target new-codex` (or `/target new-claude`), then send plain text.
- After target selection, plain text sends to that target.
- Dispatch status is printed for every send: `queued`, `started`, `sent`, `failed`.

### Scope and Limits

- Targeting is limited to active sessions in the watcher window (recent activity).
- Multi-target broadcast in one send is not implemented.

## Install (Development)

### Prerequisites

- Node.js 20+
- npm 10+
- VS Code 1.85+
- At least one provider CLI installed and authenticated:
  - `codex` / `codex.cmd`
  - `claude` / `claude.cmd`

### Build

```bash
npm ci
npm run build
```

### Deploy to Local VS Code/Cursor

```bash
npm run deploy:vscode
```

This copies `dist/` and `package.json` into your local extensions directory and replaces older Kibitz extension folders.

### Run CLI

```bash
npm run build
node dist/cli/index.js
```

## Testing

```bash
npm run typecheck
npm run check:compat
npm run test:ui
npm run test:all
```

Useful targeted checks:

```bash
npm run test:parsers
npm run check:session-names
npm run check:model-persistence
```

## Release Flow

1. Bump `version` in `package.json`.
2. Run:
   - `npm run test:all`
   - `npm run deploy:vscode` (local smoke)
3. Create extension package:
   - `npm run package` (builds `.vsix` via `vsce package`)
4. Push git tag/release notes and attach `.vsix` to GitHub release (recommended).

## Distribution Channels

## 1) VS Code Extension Marketplace

- Create publisher in VS Marketplace (if not already created).
- Create Azure DevOps PAT with Marketplace publish scopes.
- Login and publish with `vsce`.
- Recommended:
  - publish stable versions to Marketplace,
  - keep `.vsix` artifacts in GitHub Releases for manual install/rollback.

## 2) OpenVSX (for Cursor/VSCodium ecosystems)

- Publish the same extension package to OpenVSX.
- Keep version parity with Marketplace.

## 3) npm (CLI distribution)

- Keep `bin.kibitz` pointing to `dist/cli/index.js`.
- Publish package to npm.
- Users can install globally and run `kibitz`.

## 4) Homebrew

Two common paths:

- Formula that installs from npm:
  - wraps `npm install -g kibitz`.
- Tap formula that downloads built tarball/binary and installs launcher.

For VS Code extensions specifically, Homebrew is optional and usually secondary to Marketplace/OpenVSX.

## 5) GitHub Releases

- Upload `.vsix` and changelog per version.
- Add quick install instructions:
  - `code --install-extension <file>.vsix`

## Recommended Distribution Stack

For most users, start with:

1. VS Marketplace (primary VS Code install path)
2. OpenVSX (secondary ecosystem coverage)
3. npm (CLI users)
4. GitHub Releases (`.vsix` artifact + release notes)

Add Homebrew only if your CLI install demand is high and you want one-command setup for macOS/Linux.

## Docs

- [Support matrix details](docs/SUPPORT_MATRIX.md)
- [Compatibility release checklist](docs/COMPAT_CHECKLIST.md)

## Legal

- [License (MIT)](LICENSE)
- [Privacy Policy](PRIVACY.md)
- [Terms of Use](TERMS.md)

## Cross-Platform Notes

Kibitz mirrors proven `room` patterns:

- Login-shell PATH inheritance on macOS.
- npm global prefix PATH enrichment on Windows.
- Windows `.cmd` command mapping (`claude.cmd`, `codex.cmd`).
- Platform-parameterized compatibility tests.
