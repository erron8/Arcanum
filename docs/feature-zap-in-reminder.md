# Feature Spec: Zap In Reminder

Filled from `docs/feature-spec-template.md`. Implemented; kept here as the record of
intent and acceptance criteria.

## Agent Instructions

Read `AGENTS.md` first. Preserve the project invariant that ATH Drawdown Alerts are
manual-watch only: **neither** the GMGN drawdown scanner **nor** the Zap In scanner may
add candidates to `AlertStore` or `data/alerts.json`.

## Feature

Name: Zap In Reminder

Goal: Notify subscribers when a Solana token is breaking out at a *fresh* all-time high
with bullish momentum — a good moment to "zap in" (enter). It is the inverse of the
existing GMGN drawdown scanner and reuses the same GMGN client, alert-delivery, dedupe,
and rich-card infrastructure.

User Story: As a Telegram user, I want to be pinged when a young token just printed a new
ATH on strong volume and a bullish trend, so I can consider an entry without watching
charts all day.

## Behavior

Telegram commands / UI:
- `/zap` — run one Zap In scan cycle on demand and reply with counts (trending →
  quick-pass → qualified → new), plus drop reasons. Available to any authorized chat when
  a real `GMGN_API_KEY` is configured; otherwise it replies that the scanner is
  unavailable.
- `/zapstatus` — show the last cycle's summary, last delivered candidate, and last error.
- Alerts are delivered as separate `⚡ Zap In Reminder` messages (never mixed with
  `ATH Drawdown Alert` or `GMGN Screening Alert`). Each card shows a "⚡ Zap signals"
  block listing the criteria that triggered it.
- Added to the Telegram command menu and `/help`.

Trigger criteria (ALL must hold; all measured from the GMGN API):
1. **New ATH above 250K mcap** — market cap ≥ `ZAP_MARKET_CAP_MIN_USD` (250K) and the
   current price is at the ATH (drawdown ≤ `ZAP_ATH_TOLERANCE_PCT`). A price above the
   stored ATH is treated as the new ATH (drawdown 0).
2. **Good volume (> 25k / 5 min)** — the hottest recent 5m candle (last ~30 min) traded
   ≥ `ZAP_VOLUME_MIN_5M_USD` (25K).
3. **Bullish 15m Supertrend** — Supertrend over 15m candles with ATR period
   `ZAP_SUPERTREND_PERIOD` (10) and multiplier `ZAP_SUPERTREND_MULTIPLIER` (3) is in an
   up-trend at the latest bar.
4. **Just made a new ATH, token age < 2 days** — the ATH was touched within the recent 5m
   window, and the token is at most `ZAP_MAX_TOKEN_AGE_HOURS` (48h) old.
5. **Safety gate** — the security screen must have no hard-fail (no honeypot, mint+freeze
   renounced, no wash trading). Applied because a "zap in" is an actionable buy signal.

State changes:
- Reads/writes only its own dedupe store at `ZAP_SCREENED_PATH`
  (`./data/zap-screened.json`), reusing `GmgnScreenedStore`. Records a mint only after a
  successful delivery; re-alerts are suppressed for `ZAP_DEDUPE_MS` (24h).
- **Never** reads or writes `data/alerts.json` (the manual watch store) or
  `data/subscribers.json`.
- Nothing about a scanned candidate persists beyond the dedupe timestamp.

External APIs:
- GMGN OpenAPI only, via the shared `GmgnClient` (same key, pacing, retry/backoff as the
  drawdown scanner): `market/rank`, `token/info`, `token/security`,
  `token_top_holders`/`token_top_traders` (display only), and `token_kline` (5m, 15m, and
  1h for the ATH fallback).
- Per-token failures are caught and drop that token; a single failure never aborts the
  cycle. Overlapping cycles are skipped; shutdown awaits any in-flight cycle.

Config:
- New `ZAP_*` env vars (see `.env.example`), all with defaults. Backward compatible: the
  scanner is OFF by default and requires a real `GMGN_API_KEY`. Validation mirrors the
  GMGN scanner and only runs when the scanner is enabled or a real key is present.

Edge cases:
- Missing/zero price, unknown ATH, or unknown age → fail closed (token dropped).
- Too few 15m candles for a stable Supertrend → treated as not bullish (dropped).
- New high above the stored ATH → treated as the ATH (no negative drawdown).
- API failure on one token → dropped, cycle continues.
- No subscribers / delivery fails → not recorded in the dedupe store; re-alerts next cycle.
- Duplicate within the window → still screened but not re-alerted.

## Acceptance Criteria

- `/zap` and `/zapstatus` work; alerts render as `⚡ Zap In Reminder` cards with a signals
  block. ✅
- A token qualifies only when all five criteria hold; each gate short-circuits in
  ascending API-cost order. ✅
- Zap candidates are never added to the manual `AlertStore` (regression test included). ✅
- Tests added: `tests/zapScanner.test.ts` (indicators, base filter, volume, and full
  scanner orchestration incl. safety/volume/supertrend/dedupe/invariant) and Zap cases in
  `tests/config.test.ts`. ✅
- `bun run typecheck` passes; `bun test` passes. ✅

## Non-Goals

- No changes to `ATH Drawdown Alert` behavior or the manual watchlist.
- Zap candidates must never become manual watches.
- No new external data providers; GMGN only.

## Relevant files

- `src/gmgn/zapScanner.ts` — scanner + pure gates (new).
- `src/gmgn/indicators.ts` — ATR / Supertrend (new).
- `src/gmgn/zapDryrun.ts` — `bun run zap:dryrun` probe (new).
- `src/alerts/config.ts` — `ZapConfig`, `buildZapConfig`, `validateZapEnv`.
- `src/alerts/richFormat.ts` — `zap` alert kind + signals section.
- `src/alerts/telegramBot.ts` — `/zap`, `/zapstatus`, menu/help.
- `src/alerts/index.ts` — construct/wire/start the scanner.
- `tests/zapScanner.test.ts`, `tests/config.test.ts`.
