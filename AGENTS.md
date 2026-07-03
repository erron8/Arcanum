# Agent Handoff

This file gives future coding agents the minimum context needed to work safely in this
repo. Read it before changing code.

## Project

Arcanum is a Bun + TypeScript Telegram bot for Solana token ATH drawdown tracking.

Primary behavior:
- Users manually add token mints with `/watch <mint> [pct]`.
- The ATH monitor polls watched mints and sends `ATH Drawdown Alert` messages when a
  watched token crosses its configured drawdown threshold.
- `/check <mint>` renders a rich one-off token card without adding the mint to the
  watchlist.
- `/scan` runs an optional GMGN screening cycle. When `GMGN_SCANNER_ENABLED=true`, the
  GMGN scanner also runs on a timer.
- `/zap` runs an optional "Zap In" reminder cycle: it finds tokens at a *fresh* ATH
  with bullish momentum and pushes separate `Zap In Reminder` messages. When
  `ZAP_SCANNER_ENABLED=true`, it also runs on a timer. It shares the GMGN client/key.

Critical invariant:
- `ATH Drawdown Alert` is manual-watch only.
- Neither scanner may ever insert candidates into `AlertStore` or `data/alerts.json`.
  This applies to the GMGN drawdown scanner AND the Zap In scanner.
- GMGN scanner alerts are separate `GMGN Screening Alert` messages; Zap In alerts are
  separate `Zap In Reminder` messages. Both dedupe via their own screened stores.
- Do not reintroduce `GMGN_AUTO_WATCH` behavior. The legacy config field is forced off.

## Architecture

Important paths:
- `src/alerts/index.ts`: process bootstrap, config validation, store/monitor/bot wiring,
  optional GMGN scanner startup.
- `src/alerts/config.ts`: env parsing and validation.
- `src/alerts/store.ts`: manual watch store persisted at `STORE_PATH`
  (`./data/alerts.json` by default).
- `src/alerts/athMonitor.ts`: poll loop and manual watched-token alert state machine.
- `src/alerts/telegramBot.ts`: Telegram commands, command menu, alert delivery.
- `src/alerts/richFormat.ts`: rich card rendering for watch/check/GMGN messages.
- `src/gmgn/scanner.ts`: optional GMGN drawdown screening workflow and screening alerts.
- `src/gmgn/zapScanner.ts`: optional "Zap In" reminder scanner (fresh-ATH breakouts).
- `src/gmgn/indicators.ts`: pure technical indicators (ATR, Supertrend) for the Zap scanner.
- `src/gmgn/client.ts`: GMGN OpenAPI client.
- `src/fetchers/chartData.ts`: Jupiter chart fetch and ATH drawdown data.
- `tests/`: Bun tests for config, monitor, Telegram behavior, GMGN scanner, formatting,
  stores, and clients.

## Runtime State

Ignored local files:
- `.env`: local secrets/config. Do not print or commit secrets.
- `data/alerts.json`: manual watchlist and watch runtime state.
- `data/subscribers.json`: subscribed Telegram chats.
- `data/gmgn-screened.json`: GMGN scanner dedupe state.
- `data/zap-screened.json`: Zap In scanner dedupe state.

If scanner-originated watches need cleanup, compare `data/alerts.json` with
`data/gmgn-screened.json`. Only remove entries that can be attributed safely; older
watch entries may not have a source marker.

## Config Notes

Manual watching works without GMGN:
- `TELEGRAM_BOT_TOKEN` is required.
- `TELEGRAM_ALLOWED_CHAT_IDS` or `ALLOW_OPEN_BOT=true` is required.
- `GMGN_API_KEY` is optional unless automatic GMGN scanning is enabled.

GMGN:
- `GMGN_SCANNER_ENABLED=false` by default.
- `/scan` is available only when a real `GMGN_API_KEY` is configured.
- `GMGN_AUTO_WATCH` is legacy and must not add scanner mints to `/watch`.

Zap In:
- `ZAP_SCANNER_ENABLED=false` by default.
- `/zap` is available only when a real `GMGN_API_KEY` is configured (shares the client).
- Gates: mcap ≥ `ZAP_MARKET_CAP_MIN_USD`, at a fresh ATH within `ZAP_ATH_TOLERANCE_PCT`,
  a recent 5m candle ≥ `ZAP_VOLUME_MIN_5M_USD`, a bullish 15m Supertrend
  (`ZAP_SUPERTREND_PERIOD`/`ZAP_SUPERTREND_MULTIPLIER`), and no blocking security issue
  (honeypot/unrenounced/wash). Token age is shown on the card but is NOT a gate. High
  snipers / holder concentration are downgraded to warnings for the zap path.

## Commands

Development:
```bash
bun install
bun run typecheck
bun test
bun run start
```

Focused tests are useful while iterating:
```bash
bun test tests/config.test.ts tests/athMonitor.test.ts tests/telegramBot.test.ts
bun test tests/gmgnScanner.test.ts tests/zapScanner.test.ts tests/richFormat.test.ts
```

## Implementation Guidance

Follow the existing style:
- Keep changes scoped and TypeScript strict.
- Prefer existing helpers and patterns over new abstractions.
- Use tests for behavior changes, especially alert state, config validation, Telegram
  command behavior, and scanner/watch separation.
- Avoid touching ignored runtime state unless the task explicitly requires local cleanup.
- Do not log secrets or full `.env` contents.

Before finishing code changes:
- Run `bun run typecheck`.
- Run `bun test`, or explain clearly why the full suite was not run.
- Check `git status --short` and summarize changed files.

