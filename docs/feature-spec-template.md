# Feature Spec Template

Use this file as the prompt/spec for the next agent. Replace the bracketed sections.

## Agent Instructions

Read `AGENTS.md` first. Preserve the project invariant that ATH Drawdown Alerts are
manual-watch only: GMGN scanner candidates must not be added to `AlertStore` or
`data/alerts.json`.

Implement the feature below, keep changes scoped, and verify with `bun run typecheck`
and relevant `bun test` coverage.

## Feature

Name:
[Short feature name]

Goal:
[One or two sentences describing the user-facing outcome.]

User Story:
[Example: As a Telegram user, I want ..., so that ...]

## Behavior

Telegram commands or UI:
- [Command or interaction]
- [Expected reply/alert text]
- [Who is allowed to use it]

State changes:
- [Does it read/write `data/alerts.json`, `data/subscribers.json`, or another store?]
- [What should persist across restarts?]
- [What should not persist?]

External APIs:
- [Jupiter / GMGN / Meteora / other]
- [Timeout, retry, fallback behavior]

Config:
- [New env vars, defaults, validation rules]
- [Backward compatibility needs]

Edge cases:
- [Invalid input]
- [Missing data]
- [API failure]
- [No subscribers]
- [Duplicate requests]

## Acceptance Criteria

- [Concrete outcome 1]
- [Concrete outcome 2]
- [Tests added/updated]
- `bun run typecheck` passes.
- `bun test` passes, or any skipped tests are explicitly justified.

## Non-Goals

- [List behavior the agent should not implement.]
- Do not make GMGN scanner candidates become manual watches.

## Notes For This Repo

Relevant files likely to change:
- `src/alerts/telegramBot.ts`
- `src/alerts/config.ts`
- `src/alerts/athMonitor.ts`
- `src/alerts/store.ts`
- `src/gmgn/scanner.ts`
- `tests/*.test.ts`

Useful existing tests:
- `tests/athMonitor.test.ts`
- `tests/telegramBot.test.ts`
- `tests/config.test.ts`
- `tests/gmgnScanner.test.ts`

