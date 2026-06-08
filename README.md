# ATH Drawdown Indicator + Telegram Alerting Bot

TypeScript (strict) · Bun · grammY · JSON-file persistence · Jupiter datapi.

Computes a **rolling/windowed** all-time-high (ATH) and percent drawdown for Solana
tokens and sends a Telegram alert when a watched token falls a configurable % below it.

> **ATH semantics (important):** the "ATH" is the highest of (a) the highest price in
> the fetched lookback window — by default the **last 1000 daily candles** (`ATH_WINDOW`
> candles at `CHART_INTERVAL`) — and (b) the highest value the bot has **observed and
> persisted** since it started. It is a **rolling high over that window plus persisted
> observed highs**, *not* a backfilled historical ATH. Tokens older than the window
> (≈ 2.7 years at the daily default) may have had a higher all-time high outside it.

## Layout

```
src/
  models/types.ts        # canonical ChartDataPoint + alert types
  utils/indicators.ts    # RSI, Bollinger, MACD, Supertrend, calculateATHDrawdown
  utils/selfcheck.ts     # verification self-check
  fetchers/chartData.ts  # Jupiter datapi → candles + indicators
  alerts/
    config.ts            # env-overridable tunables
    store.ts             # atomic, debounced JSON persistence
    athMonitor.ts        # poll loop + ARMED/TRIGGERED state machine (transport-agnostic)
    telegramBot.ts       # grammY transport + commands
    index.ts             # bootstrap + graceful shutdown
```

## Setup

```bash
bun install
cp .env.example .env     # then set TELEGRAM_BOT_TOKEN
```

Minimum private-bot configuration:

```env
TELEGRAM_BOT_TOKEN=replace-with-your-botfather-token
TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

Then send `/start` to the bot, and add a token with:

```text
/watch <solana_mint>
```

The default alert threshold is 50% down from the rolling ATH. Override it per token
with `/watch <solana_mint> 40` or later with `/threshold <mint|all> <pct>`.

## Run

```bash
bun run src/alerts/index.ts   # or: bun run start
```

Long polling is used by default. If `WEBHOOK_URL` is set, the bot runs a webhook
server on `WEBHOOK_PORT` (default 8080) instead, validating the
`X-Telegram-Bot-Api-Secret-Token` header against `WEBHOOK_SECRET_TOKEN`. Startup
**fails** if `WEBHOOK_URL` is set without `WEBHOOK_SECRET_TOKEN`, unless you opt in
with `ALLOW_INSECURE_WEBHOOK=true`.

## Authorization (fail-closed)

Set `TELEGRAM_ALLOWED_CHAT_IDS` (comma/space-separated chat IDs) to restrict who can
use the bot. **Startup fails** if neither `TELEGRAM_ALLOWED_CHAT_IDS` nor
`ALLOW_OPEN_BOT=true` is set — the bot never silently runs open. To intentionally run
an open bot (anyone can control it), set `ALLOW_OPEN_BOT=true` (a warning is logged).
A malformed allowlist also fails startup. Subscribers outside the allowlist are
pruned on startup and never receive alerts.

## Bot commands

| Command | Description |
| --- | --- |
| `/start` | Subscribe this chat to alerts |
| `/stop` | Unsubscribe this chat from alerts |
| `/watch <mint> [pct]` | Watch a token (verified on Jupiter before saving; default threshold if `pct` omitted) |
| `/unwatch <mint>` | Stop watching |
| `/list` | List watched tokens + state |
| `/threshold <mint\|all> <pct>` | Set drawdown threshold (must be > hysteresis) |
| `/status <mint>` | Current price, rolling ATH and drawdown |
| `/resetath <mint>` | Reset stored ATH and re-arm |
| `/help` | Show help |

Mints must be base58, 32–44 chars; malformed mints are rejected with a clear reply.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** BotFather token. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | Comma-separated allowlist. Required unless `ALLOW_OPEN_BOT=true`. |
| `ALLOW_OPEN_BOT` | — | Set `true` to run an open bot with no allowlist (unsafe). |
| `TELEGRAM_CHAT_ID` | — | Optional pre-seeded alert recipient; must be an integer and allowed if allowlist is set. |
| `WEBHOOK_URL` / `WEBHOOK_PORT` | — / 8080 | Use webhook instead of long polling; port must be 1–65535. |
| `WEBHOOK_SECRET_TOKEN` | — | Validates incoming webhook POSTs (required with `WEBHOOK_URL`). |
| `ALLOW_INSECURE_WEBHOOK` | — | Set `true` to allow webhook without a secret (unsafe). |
| `DEFAULT_DRAWDOWN_THRESHOLD_PCT` | 50 | Default alert threshold (must be > hysteresis). |
| `POLL_INTERVAL_MS` | 60000 | Poll cadence (≥ 1000). |
| `ATH_WINDOW` | all | `all` or a positive candle count. |
| `ATH_MAX_CANDLES` | 1000 | Candles requested when `ATH_WINDOW=all`. |
| `ALERT_COOLDOWN_MS` | 1800000 | Min time between alerts per token. |
| `RECOVERY_HYSTERESIS_PCT` | 5 | Re-arm only after recovering this far below threshold. |
| `QUOTE` | native | `native` (SOL) or `usd`. |
| `CHART_INTERVAL` | 1_DAY | Jupiter interval (see `.env.example`; aliases like `1h` ok). |
| `FETCH_ATTEMPTS` | 3 | Fetch retry attempts (≥ 1). |
| `FETCH_BACKOFF_MS` | 500 | Base delay between fetch retries; doubles per retry. |
| `FETCH_TIMEOUT_MS` | 8000 | Per-request Jupiter timeout (≥ 1000). |
| `POLL_CONCURRENCY` | 4 | Parallel token fetches per poll cycle (≥ 1). |
| `STALE_CANDLE_MULTIPLIER` | 3 | Skip a token whose latest candle is older than N intervals (≥ 1). |
| `STORE_FLUSH_DELAY_MS` | 1000 | Debounce delay for writing watch state to disk. |
| `SEND_INTERVAL_MS` | 60 | Delay between Telegram alert messages. |
| `STORE_PATH` | ./data/alerts.json | Watch store path (must differ from subscribers). |
| `SUBSCRIBERS_PATH` | ./data/subscribers.json | Subscriber list path (must differ from store). |

> Prices are **SOL-denominated** by default (`quote=native`). Set `QUOTE=usd` for USD.
> Jupiter `time` is in seconds (converted to ms internally). Invalid env values
> fail fast at startup with a descriptive message.
>
> `persistedAth` is denominated in `QUOTE` and tagged per watch. If you change
> `QUOTE`, each token's stored ATH is **rebased** to the new denomination on its
> next poll, so stale-denomination values never corrupt drawdown math.

## State machine

- `ARMED` → `drawdown ≥ threshold` ⇒ **fire**, transition to `TRIGGERED`, stamp `lastAlertAt`.
- `TRIGGERED` → re-arm only when **both** `now - lastAlertAt ≥ ALERT_COOLDOWN_MS`
  **and** `drawdown < max(0, threshold - RECOVERY_HYSTERESIS_PCT)`. The recovery
  target is clamped at 0 so a (rejected, but legacy-possible) threshold ≤ hysteresis
  can still re-arm at full recovery instead of getting stuck forever.

`persistedAth` only moves up automatically; it is lowered only by `/resetath`.

## Delivery & lifecycle

- **Delivery-confirmed at-least-once:** a breach is marked `TRIGGERED` only after
  Telegram *accepts* the send to ≥ 1 authorized subscriber. No subscribers, a `5xx`,
  a network error, or a crash mid-send ⇒ it stays `ARMED` and re-fires next cycle
  (and since `TRIGGERED` is persisted only after delivery, a restart re-fires too).
- **Send failures:** `429` is retried after the server's `retry_after`; `403`
  (blocked/deleted chat) drops the dead subscriber; `5xx`/network ⇒ not consumed.
- **`/stop` honored mid-flight:** membership is re-checked before each send, so an
  unsubscribed chat won't receive an in-flight batch.
- **Per-token backoff:** a token that keeps failing to fetch is skipped with
  exponential backoff (capped at 30 min) so it can't stall poll cycles; a short
  `FETCH_TIMEOUT_MS` bounds each request.
- **Observability:** `/status` and `/list` show last drawdown, last-check age, and a
  ⚠️ stale marker so illiquid/no-fresh-candle tokens don't look "broken."
- **Fast commands:** `/watch` and `/status` acknowledge immediately and do the (slow)
  Jupiter work asynchronously, so webhook requests never block on network I/O.
- **Fail-fast startup:** a `getMe` preflight validates the token before the monitor
  starts; if long polling later dies (e.g. a `409` from another running instance) the
  process shuts down rather than looking alive.
- **Quote changes are safe:** `persistedAth` is denominated and rebased on quote change.

## Verification

```bash
bun run typecheck    # tsc --noEmit (strict) — must pass
bun run selfcheck    # prints PASS for calculateATHDrawdown sample
bun test             # unit + integration tests (indicators, store, monitor, config,
                     #   format, auth, and Telegram commands/delivery with a mocked API)
```

Self-check: `calculateATHDrawdown([1,2,3,2,1.5],[1,2,3,2,1.5])`
⇒ `ath=[1,2,3,3,3]`, `drawdownPct≈[0,0,0,33.33,50]`.

Live check: `/watch` a token, set `/threshold` just above the current drawdown
(no alert), then lower it below (exactly **one** alert); confirm cooldown +
recovery re-arms it.

## Publishing to GitHub

This repository is intended to be safe to publish after you configure git:

```bash
git init
git add .
git status --short
```

Before committing, confirm:

- `.env` is not staged. It contains the real `TELEGRAM_BOT_TOKEN`.
- `data/*.json` is not staged. Those files contain local subscriber/watch state.
- `node_modules/`, logs, build output, and coverage output are not staged.
- The verification commands above pass.

Recommended first commit:

```bash
git commit -m "Initial ATH drawdown Telegram bot"
git branch -M main
git remote add origin <your-new-repo-url>
git push -u origin main
```
