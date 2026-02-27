# Kibitz

Kibitz adds live commentary and cross-session prompt dispatch for Claude Code and Codex sessions.

## Support Matrix (Contract)

| Platform | VS Code panel | Terminal CLI |
| --- | --- | --- |
| macOS | Supported | Supported |
| Windows | Supported | Supported |
| Linux | Best effort | Best effort |

## Session Control Composer

- Plain text sends to the selected target session.
- Slash commands remain behavior controls: `/help`, `/pause`, `/resume`, `/clear`, `/focus`, `/model`, `/preset`.
- Targets:
  - Active existing session
  - New Codex session
  - New Claude session

## Docs

- [Support matrix details](docs/SUPPORT_MATRIX.md)
- [Compatibility release checklist](docs/COMPAT_CHECKLIST.md)

## Room Parity Reference

Kibitz intentionally mirrors proven cross-platform patterns from `room`:

- Login-shell PATH inheritance on macOS.
- npm global prefix PATH enrichment on Windows.
- Windows `.cmd` CLI command handling and `.cmd -> .js` resolution.
- Platform-parameterized command-construction tests.
