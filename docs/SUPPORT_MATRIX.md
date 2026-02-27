# SUPPORT_MATRIX

## Scope

This document defines Kibitz compatibility guarantees for session control and dispatch.

## Compatibility Matrix

| Dimension | Guaranteed | Notes |
| --- | --- | --- |
| macOS | Yes | Full contract support |
| Windows | Yes | Full contract support |
| Linux | Best effort | Not contract-guaranteed in this phase |
| VS Code panel | Yes | Target picker + dispatch statuses + interactive launcher |
| Terminal CLI | Yes | `/sessions`, `/target`, plain-text dispatch |

## Platform Behavior Rules

## Command Mapping

| Provider | macOS/Linux command | Windows command |
| --- | --- | --- |
| Claude | `claude` | `claude.cmd` |
| Codex | `codex` | `codex.cmd` |

## Existing Session Dispatch

- Codex: `codex exec resume --json --skip-git-repo-check <sessionId> <prompt>`
- Claude: `claude -p <prompt> --output-format stream-json --resume <sessionId>`

## Dispatch Targeting Rules

- Users can target any active session in the watcher list.
- VS Code panel target model:
  - `/1` is always new-session target for the current provider.
  - `/2..N` map to existing active sessions.
  - New terminal session flow is intentionally simple: choose `/1`, send prompt.
  - click target badge, `/N`, `/N <prompt>`, and `N/ <prompt>` are supported.
- Terminal CLI target model:
  - `/sessions` prints indexed active sessions.
  - `/target <index|agent:sessionId|new-codex|new-claude>` selects dispatch target.
  - New terminal session flow is one command: `/target new-codex` or `/target new-claude`.
  - plain non-slash text sends to selected target.
- Dispatch must never silently reroute to another session when selected target is stale/missing.

## New Session Dispatch

- VS Code panel launches interactive session via `dist/vscode/interactive-launcher.js` in an integrated terminal.
- Terminal CLI launches provider directly with inherited stdio.

## PATH Inheritance

- macOS: login shell PATH merge (`zsh -lic` with `bash` fallback).
- Windows: npm global prefix enrichment using `npm.cmd prefix -g`.
- Linux: npm prefix enrichment (best effort).

## Interface Parity Requirements

- Both interfaces must support selecting an existing session target and new-session targets.
- Both interfaces must preserve slash control behavior (`/focus`, `/model`, `/preset`, `/pause`, `/resume`).
- Both interfaces must send plain non-slash text to the selected dispatch target.
- Dispatch statuses must be explicit (`queued`, `started`, `sent`, `failed`).

## Explicit Non-goals

- Linux parity is not a hard guarantee in this phase.
- Multi-target broadcast send is not implemented.
- Long-term historical target browsing is not implemented (active-session window only).

## Room Parity Reference

Patterns copied from room for reliability:

- startup PATH inheritance (`shell-path` logic)
- provider command mapping by OS (`provider-cli` logic)
- `.cmd` wrapper resolution to `.js` where needed
- platform-parameterized compatibility tests
