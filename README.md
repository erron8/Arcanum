# 📜 Arcanum

**📜 Arcanum** is a Telegram bot that tracks drawdown from all‑time highs (ATH) for the
Solana tokens you manually add to your watchlist.

Built with **Bun** + **TypeScript** + **grammY**, powered by the **GMGN**, **Jupiter**,
and **Meteora** APIs.

---

## What it does

- 🔍 **Manual tracking** — `/check <mint>` renders a full token card for **any** coin
  instantly; `/watch <mint>` follows a token and pings you the moment it crosses your
  drawdown threshold.
- 🔎 **Optional GMGN screening** — `/scan` runs one GMGN screening cycle on demand. Set
  `GMGN_SCANNER_ENABLED=true` only if you want the timer. Scanner candidates are not
  added to `/watch`.
- ⚡ **Optional Zap In reminders** — `/zap` finds tokens at a **fresh ATH** with bullish
  momentum (mcap ≥ 250K, a hot recent 5m candle, a bullish 15m Supertrend, and no security
  red flags) and pings you a separate `Zap In Reminder`. Set
  `ZAP_SCANNER_ENABLED=true` for the timer. Like the screener, its candidates are not
  added to `/watch`.
- 📊 **Rich cards** — every alert and card shows market cap (now ⇨ ATH), drawdown,
  liquidity, 24h volume, top holders, smart‑money/KOL activity, socials, and the token's
  **Meteora DLMM pools** — with the name linked to **GMGN**.

Works in DMs and **group chats** (replies tag whoever ran the command).

---

## Example card

```
🔍 drooling cat  [$1.38M]  [⬇️50.31%]  $DROOLING

🏔 ATH Marketcap: $2.76M

🌐 Solana @ Pump.fun
💎 Marketcap: $1.38M ⇨ $2.76M
💦 Liq: $102.2K  [x13.4]
📊 Vol: $1.38M  ·  Age: 15.0d

👥 TH: 3.7 · 3.3 · 2.9 · 2.7 · 2.3  [top10 23%]
🤝 Holders: 1983
🧠 SM holding 1 · KOL 3 · SM exited 2 · SM unreal+ 1

🌐 Web · 🐦 X · 💬 TG
📈 DEX · Birdeye · GMGN · Solscan · Pump

🌊 Meteora pools:
1. drooling/SOL 100/2% | TVL : 32.3K
2. drooling/USDC 20/2% | TVL : 1.4K

BcHEaa…pump
```

The **name** links to GMGN, every link is tappable, and the trailing `$TICKER` is a
cashtag — tap it to search the chat for that token.

---

## Quick start

**Requirements:**

- [Bun](https://bun.sh)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A **GMGN OpenAPI key** — optional; it powers richer token data and the optional
  GMGN drawdown scanner and Zap In scanner. Get one at
  [gmgn.ai → API Management](https://gmgn.ai/ai?chain=sol&tab=api_management) → **Create
  API Key**.

```bash
git clone https://github.com/<your-username>/Arcanum.git
cd Arcanum
bun install
cp .env.example .env
```

Edit `.env` and set at least:

```env
TELEGRAM_BOT_TOKEN=your-botfather-token
TELEGRAM_ALLOWED_CHAT_IDS=123456789      # your Telegram chat/user id(s), comma-separated
# optional:
GMGN_API_KEY=your-gmgn-openapi-key
```

> Don't know your chat id? Message [@userinfobot](https://t.me/userinfobot). The
> allowlist keeps your bot private — only listed chats can use it.

Run it:

```bash
bun run start
```

Send `/start` to the bot first (or set `TELEGRAM_CHAT_ID` in `.env`) so watched-token
alerts have a delivery target.

To track a specific coin yourself, send **`/watch <token_mint>`** (alerts at 50% below
ATH by default; set your own with `/watch <mint> 40`), or get a one‑off card with
**`/check <token_mint>`**.

To use the bot in a **group**, just invite it and have members run commands there.

---

## Commands

| Command | What it does |
| --- | --- |
| `/start` | Subscribe this chat to alerts |
| `/stop` | Unsubscribe this chat from alerts |
| `/watch <mint> [pct]` | Watch a token (default 50% drawdown, or set your own) |
| `/unwatch <mint>` | Stop watching a token |
| `/list` | Show your watchlist and each token's current drawdown |
| `/threshold <mint\|all> <pct>` | Change the alert threshold |
| `/status <mint>` | Quick price / ATH / drawdown for a watched token |
| `/check <mint>` | Full token card for **any** mint (no need to watch it) |
| `/resetath <mint>` | Reset a token's stored ATH and re‑arm its alert |
| `/scan` | Run the trending‑memecoin drawdown scan right now |
| `/gmgnstatus` | Summary of the last scan (counts, drop reasons, last alert, errors) |
| `/zap` | Scan now for Zap In (fresh‑ATH breakout) reminders |
| `/zapstatus` | Summary of the last Zap In scan |
| `/testalert` | Preview one of each alert (ATH drawdown, GMGN screening, Zap In) |
| `/help` | List all commands |

All commands also appear in Telegram's **Menu** button and `/` autocomplete.

---

## Optional GMGN Scanning

The scanner runs **on demand** with `/scan`. If you want automatic GMGN screening too,
set `GMGN_SCANNER_ENABLED=true` and provide `GMGN_API_KEY`; the timer runs every
5 minutes by default. Each pass:

1. Pulls the current trending Solana memecoins from GMGN.
2. Keeps only coins that are **deep in drawdown** (≥ 50% below ATH by default) **but
   still active** — real trading fees, healthy market cap, and a sensible token age.
3. **Screens the survivors** — mint/freeze renounced, low rug ratio and holder
   concentration, acceptable snipers/bundlers, and no wash‑trading; smart‑money/KOL
   activity is shown when present. Clearly unsafe coins are dropped; borderline ones
   (including coins with no smart‑money signal) are flagged ⚠️ but still sent.
4. Sends a GMGN screening card for each coin that passes (de‑duplicated so you aren't
   pinged twice for the same coin within 24h).

Scanner candidates are never written to the manual watchlist. ATH Drawdown Alerts come
only from tokens you add with `/watch <mint>`.

Tune every threshold (drawdown %, min fees, market cap, token age, cadence, etc.) with
the `GMGN_*` variables in [`.env.example`](./.env.example). `/gmgnstatus` shows what the
last scan did, and `bun run gmgn:dryrun` runs one scan to the console without sending
anything.

**Meteora DLMM pool links** are added to every card automatically (public API, no key);
turn them off with `METEORA_LINKS_ENABLED=false`.

---

## Optional Zap In Reminders

The **inverse** of the drawdown scanner. It runs **on demand** with `/zap` (and on a
timer when `ZAP_SCANNER_ENABLED=true`), sharing the same `GMGN_API_KEY`. Instead of coins
deep in drawdown, it looks for coins that are **breaking out at a fresh ATH**. A coin is
sent as a `Zap In Reminder` only when **all** of these hold:

1. **New ATH above 250K mcap** — market cap ≥ `ZAP_MARKET_CAP_MIN_USD` and the current
   price is at the ATH (within `ZAP_ATH_TOLERANCE_PCT`).
2. **Good 5‑minute volume** — a recent 5m candle traded ≥ `ZAP_VOLUME_MIN_5M_USD`.
3. **Bullish 15m Supertrend** — computed from 15m candles (`ZAP_SUPERTREND_PERIOD` /
   `ZAP_SUPERTREND_MULTIPLIER`, default 10 / 3).
4. **Just made that new ATH** — the ATH was touched within the recent 5m window.
5. **Not obviously unsafe** — mint/freeze renounced, no honeypot, no wash trading. (High
   snipers / holder concentration are shown as warnings, not blocks.)

Everything is measured from the GMGN API. Token age is shown on the card but is **not** a
filter. Zap In candidates are de‑duplicated (24h) and, like the drawdown scanner, are
**never** written to the manual `/watch` watchlist. `/zapstatus` shows what the last Zap
scan did, and `bun run zap:dryrun` runs one Zap cycle to the console without sending
anything. Tune every threshold with the `ZAP_*` variables in
[`.env.example`](./.env.example).

---

## Configuration

The most common settings:

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Your BotFather token. |
| `GMGN_API_KEY` | — | Optional. Powers GMGN card data and `/scan`. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | Allowed chat ids (keeps the bot private). |
| `TELEGRAM_CHAT_ID` | — | Optional chat pre‑seeded to receive alerts. |
| `GMGN_SCANNER_ENABLED` | false | Run the GMGN scanner on a timer. |
| `GMGN_SCAN_INTERVAL_MS` | 300000 | How often the scanner runs (≥ 60000). |
| `GMGN_DRAWDOWN_MIN_PCT` | 50 | Min % below ATH for the scanner to flag a coin. |
| `ZAP_SCANNER_ENABLED` | false | Run the Zap In (fresh‑ATH) scanner on a timer. |
| `ZAP_VOLUME_MIN_5M_USD` | 25000 | Min USD in a recent 5m candle for a Zap In reminder. |
| `ZAP_ATH_TOLERANCE_PCT` | 15 | Max % below ATH to still count as "at a new ATH". |
| `DEFAULT_DRAWDOWN_THRESHOLD_PCT` | 50 | Default `/watch` alert threshold. |
| `POLL_INTERVAL_MS` | 60000 | How often watched tokens are checked. |
| `QUOTE` | native | `native` (SOL) or `usd` for the `/watch` price/ATH. |
| `METEORA_LINKS_ENABLED` | true | Show Meteora DLMM pool links on cards. |

👉 **Every available option is documented with comments in
[`.env.example`](./.env.example)** — including all scanner thresholds, webhook mode,
and fetch tuning.

---

## Good to know

- **ATH is rolling, not historical.** The ATH is the highest price seen in the recent
  lookback window (1000 daily candles by default) plus any higher value observed while
  the bot runs — not a full‑history backfill. Very old tokens may have peaked earlier.
- **Cashtag search** (`$TICKER`) only works for tickers that are 1–8 letters with no
  digits — that's a Telegram rule, not a bug.
- **Best‑effort data.** If GMGN or Meteora is slow or down, the bot still sends the
  alert with whatever data it has; it never blocks on enrichment.
- **Alerts are delivery‑confirmed.** A token is only marked "alerted" once Telegram
  accepts the message, so you won't miss an alert if delivery fails — it retries.

---

## Development

```bash
bun run start        # run the bot (long polling, or webhook if WEBHOOK_URL is set)
bun test             # run the test suite
bun run typecheck    # strict TypeScript check
bun run gmgn:dryrun  # run one GMGN drawdown scan and print results (no Telegram, needs GMGN_API_KEY)
bun run zap:dryrun   # run one Zap In scan and print results (no Telegram, needs GMGN_API_KEY)
```

State is stored as JSON under `data/` (watchlist, subscribers, and the GMGN + Zap
scanner dedupe stores).

---

## Security

- **Never commit your `.env`** — it holds your bot token (and GMGN key). It's
  gitignored, along with everything in `data/`.
- The bot is **private by default**: it refuses to start without an allowlist unless you
  explicitly set `ALLOW_OPEN_BOT=true`.
