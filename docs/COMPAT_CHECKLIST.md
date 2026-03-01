# COMPAT_CHECKLIST

Release must not ship unless all checks below pass.

## Required Matrix Coverage

- [ ] macOS + VS Code panel
- [ ] macOS + Terminal CLI
- [ ] Windows + VS Code panel
- [ ] Windows + Terminal CLI

## Session Dispatch Validation

- [ ] Existing-session send works for Codex resume command construction.
- [ ] Existing-session send works for Claude resume command construction.
- [ ] New Codex interactive session launch works.
- [ ] New Claude interactive session launch works.
- [ ] VS Code: `/1` selects new-session target for current provider.
- [ ] VS Code: `/2..N` map to existing active sessions.
- [ ] VS Code: `/N <prompt>` sends to that specific target session.
- [ ] CLI: `/sessions` index list matches active watcher sessions.
- [ ] CLI: `/target <index>` selects the intended existing session.
- [ ] CLI: `/target agent:sessionId` selects the intended existing session.
- [ ] CLI: plain non-slash text is dispatched to current selected target.
- [ ] Stale/missing target fails clearly and does not silently reroute.

## UX / Behavior Regression

- [ ] Session count equals active-session list size.
- [ ] Session title shown in feed matches selected session context.
- [ ] Model selector shows all available connected-provider models.
- [ ] Slash behavior still works (`/focus`, `/model`, `/preset`, `/interval`, `/pause`, `/resume`).

## Gates

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run check:compat`
- [ ] CI workflow `compat.yml` passes on both macOS and Windows
