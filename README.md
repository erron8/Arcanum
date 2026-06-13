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
    telegramBot.ts       # grammY transport + commands + generic notify()
    index.ts             # bootstrap + graceful shutdown
  gmgn/                  # optional GMGN drawdown scanner (disabled by default)
    client.ts            # GMGN OpenAPI client (auth, retries; injectable fetch)
    types.ts             # GMGN response types
    scanner.ts           # base filter + screening workflow + cron loop
    format.ts            # MarkdownV2 screening-alert rendering
    store.ts             # dedupe store (./data/gmgn-screened.json)
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
| `/scan` | Run a GMGN drawdown scan cycle now (only when the scanner is enabled) |
| `/testalert` | Preview an example alert (rendered for SOL) without waiting for a real trigger |
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
| `GMGN_SCAN_ENABLED` | false | Enable the GMGN drawdown scanner. |
| `GMGN_API_KEY` | — | **Required when enabled.** GMGN OpenAPI key. Never commit it. |
| `GMGN_SCAN_INTERVAL_MS` | 300000 | Scan cadence (≥ 60000). |
| `GMGN_TOTAL_FEE_MIN_SOL` | 30 | Min total trading fees (SOL). |
| `GMGN_MARKET_CAP_MIN_USD` | 250000 | Min market cap (USD). |
| `GMGN_DRAWDOWN_MIN_PCT` | 50 | Min % down from ATH ([0, 100]). |
| `GMGN_MIN_TOKEN_AGE_HOURS` | 4 | Min token age (must be < max). |
| `GMGN_MAX_TOKEN_AGE_DAYS` | 14 | Max token age. |
| `GMGN_SCAN_LIMIT` | 100 | Trending rows per scan ([1, 100]). |
| `GMGN_SCAN_CONCURRENCY` | 4 | Parallel token screenings ([1, 32]). |
| `GMGN_DEDUPE_MS` | 86400000 | Don't re-alert a mint within this window. |
| `GMGN_AUTO_WATCH` | false | Also add passing mints to `/watch` at threshold 50. |
| `GMGN_SCREENED_PATH` | ./data/gmgn-screened.json | Dedupe store path (gitignored). |

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

## GMGN drawdown scanner (optional, disabled by default)

An optional in-process cron that finds Solana coins that are **deep in drawdown but
still alive**, screens them, and sends Telegram **screening alerts** to your existing
subscribers. It is **disabled by default** and never touches the `/watch` flow.

Enable it with:

```env
GMGN_SCAN_ENABLED=true
GMGN_API_KEY=your-gmgn-openapi-key   # REQUIRED when enabled; never commit it
```

Every 5 minutes (`GMGN_SCAN_INTERVAL_MS`, runs once immediately on startup) the
scanner:

1. **Candidate source** — pulls trending tokens from `GET /v1/market/rank`
   (`chain=sol, interval=5m, order_by=volume`, filters `renounced/frozen/not_wash_trading`),
   then applies a cheap client-side quick filter (market cap, wash-trading, bundler
   rate, smart-money presence).
2. **Base filter** (`GET /v1/token/info`) — keeps a token only if **all** hold:
   `total_fee ≥ GMGN_TOTAL_FEE_MIN_SOL`, market cap ≥ `GMGN_MARKET_CAP_MIN_USD`
   (uses `market_cap`, else `price × circulating_supply`), token age within
   `[GMGN_MIN_TOKEN_AGE_HOURS, GMGN_MAX_TOKEN_AGE_DAYS]`, and drawdown from ATH
   ≥ `GMGN_DRAWDOWN_MIN_PCT`. Drawdown uses `ath_price`; when that field is missing
   it falls back to the ATH computed over the token's **full lifetime** kline
   (hourly candles from launch), and fails closed if no ATH can be established.
3. **Screening workflow** — security audit
   (`/v1/token/security`), holders/traders smart-money + KOL extraction
   (`token_top_holders` / `token_top_traders`), and 5m-kline volume-authenticity
   checks cross-referenced with wash/bundler/rat/bot stats. Hard-fail conditions
   (mint/freeze not renounced **or renounce status unknown**, wash trading, `rug_ratio > 0.30`,
   `top_10_holder_rate > 0.50`, `creator_hold`, `sniper_count > 20`,
   `bundler_trader_amount_rate > 0.40`) yield a **FAIL** verdict and are **blocked**;
   mid-band values become **WARN**; clean tokens are **PASS**.
4. **Alert** — `PASS`/`WARN` candidates are sent in the shared **rich layout**
   (see below) via the same authorized-subscriber + retry path as drawdown alerts
   (`bot.notify`). Each mint is recorded in `./data/gmgn-screened.json` so it isn't
   re-alerted within `GMGN_DEDUPE_MS` (default 24h). Delivery is recorded only after a
   subscriber actually receives it, so an undelivered batch retries next cycle.

Safety & robustness:

- **No hardcoded secrets** — the API key is read only from `GMGN_API_KEY`; startup
  **fails** if `GMGN_SCAN_ENABLED=true` without a key. The key is never logged or put
  in a URL (auth is the `X-APIKEY` header; each request adds a fresh `timestamp` and
  random `client_id`).
- **Resilient** — 429/5xx/network failures are retried with backoff; one token's
  failure never aborts the scan cycle; overlapping cycles are skipped and logged.
- **Optional auto-watch** — with `GMGN_AUTO_WATCH=true`, passing mints are also added
  to the `/watch` store at threshold 50 (default **false**).
- **Manual trigger** — send `/scan` in Telegram to run one cycle on demand instead of
  waiting for the interval. It reuses the same overlap guard (replies "already running"
  if a cycle is in flight) and reports the cycle counts (trending → quick-pass →
  base-pass → deliverable → new alerts).

## Alert layout

Both the `/watch` drawdown alerts and the GMGN screening alerts share one rich,
scanner-style MarkdownV2 layout (`src/alerts/richFormat.ts`): name + `$TICKER` with a
drawdown/verdict tag, chain @ launchpad, price, FDV now ⇨ at-ATH, liquidity (+ FDV/liq
ratio), volume, 1H volume + change, top-holder amounts (each linking to Solscan),
holder count + bundled %, a smart-money/KOL summary, socials, chart/explorer links,
**Meteora DLMM pool links** (top pools by TVL, labeled `PAIR binStep/baseFee%`), the
contract address, and a row of quick-buy trading-bot deeplinks (**no referral codes**).

Meteora links come from the public DLMM Data API (`src/meteora/client.ts`, no key);
they're enabled by default (`METEORA_LINKS_ENABLED`, `METEORA_MAX_POOLS` — top 5 by
TVL) and fetched best-effort at delivery time, so a Meteora outage never blocks an
alert.

Every field is best-effort — anything missing is simply omitted, so the same renderer
works whether it has a full GMGN payload or only a price/ATH. GMGN screening alerts are
fully populated from the scan. `/watch` alerts carry the Jupiter price/ATH/drawdown and
threshold, and are **enriched** with the GMGN fields (market cap, liquidity, holders,
etc.) whenever `GMGN_API_KEY` is set — enrichment is best-effort and failures fall back
to the basic view, so `/watch` never breaks if GMGN is down or unconfigured.

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

- `.env` is not staged. It contains the real `TELEGRAM_BOT_TOKEN` (and, if you use the
  scanner, your real `GMGN_API_KEY`). **Never commit real API keys.**
- `data/*.json` is not staged. Those files contain local subscriber/watch/screening state.
- `node_modules/`, logs, build output, and coverage output are not staged.
- The verification commands above pass.

Recommended first commit:

```bash
git commit -m "Initial ATH drawdown Telegram bot"
git branch -M main
git remote add origin <your-new-repo-url>
git push -u origin main
```
