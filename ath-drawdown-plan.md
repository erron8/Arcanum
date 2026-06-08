# Plan — ATH Drawdown Indicator + Telegram Alerting Bot

**Stack:** TypeScript (strict) · Bun · grammY · JSON-file persistence · Jupiter datapi
**Scope:** Greenfield (no existing repo). This plan also *defines* the conventions the spec assumes already exist.

---

## 0. Confirmed facts (verified, not assumed)

Jupiter endpoint `https://datapi.jup.ag/v2/charts/<mint>?interval=<i>&to=<ms>&candles=<n>&type=price&quote=native` returns:

```jsonc
{ "candles": [ { "time": 1774954170, "open": 1.5e-7, "high": 1.5e-7, "low": 1.5e-7, "close": 1.5e-7, "volume": 122.6 } ] }
```

- `time` is **seconds** (multiply ×1000 for JS Date).
- Prices are floats, frequently in scientific notation (e.g. `1.5e-7`) — never parse as int, never round-trip through fixed precision.
- `quote=native` → price in SOL. Use `quote=usd` if USD display is wanted; pick **native** as default and state inline.
- Candles arrive **oldest→newest**, contiguous. Last element = latest candle = current price proxy.

---

## Part A — Fifth indicator

### A1. `src/utils/indicators.ts` — add `calculateATHDrawdown`

```ts
calculateATHDrawdown(
  highs: number[],
  closes: number[]
): { ath: number | null; drawdownPct: number | null }[]
```

Rules (causal, O(n), no look-ahead, no mutation):
- Running max over `highs[0..i]`; if `highs[k]` is `NaN`/missing → fall back to `closes[k]` for that candle.
- `drawdownPct = max(0, (ath - close) / ath * 100)`. Fresh ATH ⇒ `0`.
- Index 0 defined whenever a valid price exists (single candle's ATH is itself).
- Emit `null` only when no valid price seen yet.
- `ath <= 0` ⇒ `drawdownPct = null` (division guard).
- Sit alongside the 4 existing indicators; signatures of RSI/Bollinger/MACD/Supertrend untouched.

### A2. `src/models/types.ts` — extend canonical `ChartDataPoint`

```ts
athPrice?: number | null;
drawdownFromATH?: number | null; // percent, 0 = at ATH
```

### A3. `src/fetchers/chartData.ts`

- Mirror the same two optional fields on the duplicate local interface (keep in sync).
- `import { calculateATHDrawdown } from '../utils/indicators';`
- After candles built: `const ath = calculateATHDrawdown(highs, closes);`
- In the final `candles.map((c, i) => ({ ...c, /* 4 existing */, athPrice: ath[i].ath, drawdownFromATH: ath[i].drawdownPct }))`.
- Do not touch the four existing indicator attachments.

---

## Part B — Telegram bot (4 files)

### Tunables (env-overridable constants)
```
DEFAULT_DRAWDOWN_THRESHOLD_PCT = 50
POLL_INTERVAL_MS              = 60_000
ATH_WINDOW                    = 'all'
ALERT_COOLDOWN_MS             = 30 * 60_000
RECOVERY_HYSTERESIS_PCT       = 5
```

### B1. `src/alerts/store.ts` — JSON-file persistence
- Shape: `{ [mint]: { symbol?, threshold, persistedAth, state: 'ARMED'|'TRIGGERED', lastAlertAt } }`.
- Atomic writes (write temp → `rename`) to survive crashes mid-write.
- `persistedAth` updates **upward only**; lowered only by `/resetath`.
- Debounced flush so a poll cycle isn't 1 write per token.

### B2. `src/alerts/athMonitor.ts` — watch loop + state machine (pure-ish, testable)
- Per token: retry-with-backoff around `fetchChartData` (reuse it — no duplicated API logic); one token failing never kills the loop.
- Compute current ATH + `drawdownFromATH` from Part A on the freshest candles; reconcile against `persistedAth` (take the max).
- State machine:
  - `ARMED` → `drawdown >= threshold` ⇒ **fire**, → `TRIGGERED`, stamp `lastAlertAt`.
  - `TRIGGERED` → re-arm only when **both**: `now - lastAlertAt >= ALERT_COOLDOWN_MS` **and** `drawdown < threshold - RECOVERY_HYSTERESIS_PCT`.
- Emits alert payloads (symbol/mint, price, ATH, %down, threshold, Jupiter + Birdeye links) — transport-agnostic so it's unit-testable without Telegram.

### B3. `src/alerts/telegramBot.ts` — grammY transport + commands
- grammY (per your preference). Long polling default; webhook if `WEBHOOK_URL` set.
- Commands: `/start /watch <mint> [pct] /unwatch <mint> /list /threshold <mint|all> <pct> /status <mint> /resetath <mint> /help`.
- Mint validation: base58, 32–44 chars; reject malformed with clear reply.
- Send rate-limiting + debounce so a multi-token breach batches into grouped messages (respect Telegram ~30 msg/s, but throttle well under).
- Markdown-formatted alerts.

### B4. `src/alerts/index.ts` — bootstrap
- Load env via dotenv if present, else `process.env`. Fail fast if `TELEGRAM_BOT_TOKEN` missing.
- Wire store → monitor → bot. Graceful shutdown on SIGINT/SIGTERM (flush store, stop polling).

---

## Deliverables (in dependency order)
1. `calculateATHDrawdown` full function.
2. Diffs: `types.ts`, `chartData.ts`.
3. Full `store.ts`, `athMonitor.ts`, `telegramBot.ts`, `index.ts`.
4. README snippet: env vars, run command (`bun run src/alerts/index.ts`), example commands.
5. Verification section.

## Verification
- `npx tsc --noEmit` (strict) passes.
- Self-check: `calculateATHDrawdown([1,2,3,2,1.5],[1,2,3,2,1.5])` ⇒ `ath=[1,2,3,3,3]`, `drawdownPct≈[0,0,0,33.33,50]` → print PASS/FAIL.
- Live: `/watch` a token, set `/threshold` just above current drawdown (no alert), lower below it (exactly ONE alert), confirm cooldown+recovery re-arms.

## Assumptions stated inline
- `quote=native` default (SOL-denominated); swap to `usd` if USD wanted.
- Jupiter `time` is seconds.
- grammY + JSON store per your choices.
- Greenfield: this plan defines conventions; real code will follow the import/null patterns set here.
