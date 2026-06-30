# 📜 Arcanum

**📜 Arcanum** is a Telegram bot that **automatically and manually tracks drawdown from
trending Solana memecoins** — coins that have fallen far below their all‑time high (ATH)
but are still alive.

Built with **Bun** + **TypeScript** + **grammY**, powered by the **GMGN**, **Jupiter**,
and **Meteora** APIs.

---

## What it does

- 🔎 **Automatic scanning** — a built‑in scanner continuously sweeps **trending Solana
  memecoins**, keeps the ones that are deep in drawdown but still active, screens them
  for safety (renounce status, holder concentration, snipers, bundlers, wash‑trading,
  smart‑money), and alerts you on the survivors. Runs on a timer and on demand via
  `/scan`.
- 🔍 **Manual tracking** — `/check <mint>` renders a full token card for **any** coin
  instantly; `/watch <mint>` follows a token and pings you the moment it crosses your
  drawdown threshold.
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
- A **GMGN OpenAPI key** — required; it powers the trending‑memecoin scanning and the
  rich token data on every card. Get one at
  [gmgn.ai → API Management](https://gmgn.ai/ai?chain=sol&tab=api_management) → **Create
  API Key**.

```bash
git clone https://github.com/erron8/Arcanum.git
cd Arcanum
bun install
cp .env.example .env
```

Edit `.env` and set at least:

```env
TELEGRAM_BOT_TOKEN=your-botfather-token
TELEGRAM_ALLOWED_CHAT_IDS=123456789      # your Telegram chat/user id(s), comma-separated
GMGN_API_KEY=your-gmgn-openapi-key
```

> Don't know your chat id? Message [@userinfobot](https://t.me/userinfobot). The
> allowlist keeps your bot private — only listed chats can use it.

Run it:

```bash
bun run start
```

The scanner starts sweeping trending memecoins immediately and then on a timer.

> ⚠️ **Send `/start` to the bot first** (or set `TELEGRAM_CHAT_ID` in `.env`). Automatic
> scanner alerts are only delivered to chats that have subscribed — with no subscribers,
> the scanner finds candidates but has nowhere to send them.

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
| `/testalert` | Preview what an alert looks like |
| `/help` | List all commands |

All commands also appear in Telegram's **Menu** button and `/` autocomplete.

---

## How scanning works

The scanner runs **automatically on a timer** (every 5 minutes by default) and **on
demand** with `/scan`. Each pass:

1. Pulls the current trending Solana memecoins from GMGN.
2. Keeps only coins that are **deep in drawdown** (≥ 50% below ATH by default) **but
   still active** — real trading fees, healthy market cap, and a sensible token age.
3. **Screens the survivors** — mint/freeze renounced, low rug ratio and holder
   concentration, acceptable snipers/bundlers, and no wash‑trading; smart‑money/KOL
   activity is shown when present. Clearly unsafe coins are dropped; borderline ones
   (including coins with no smart‑money signal) are flagged ⚠️ but still sent.
4. Sends a card for each coin that passes (de‑duplicated so you aren't pinged twice for
   the same coin within 24h).

Tune every threshold (drawdown %, min fees, market cap, token age, cadence, etc.) with
the `GMGN_*` variables in [`.env.example`](./.env.example). `/gmgnstatus` shows what the
last scan did, and `bun run gmgn:dryrun` runs one scan to the console without sending
anything.

**Meteora DLMM pool links** are added to every card automatically (public API, no key);
turn them off with `METEORA_LINKS_ENABLED=false`.

---

## Configuration

The most common settings:

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Your BotFather token. |
| `GMGN_API_KEY` | — | **Required.** Powers the scanner + card data. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | Allowed chat ids (keeps the bot private). |
| `TELEGRAM_CHAT_ID` | — | Optional chat pre‑seeded to receive scanner alerts. |
| `GMGN_SCAN_INTERVAL_MS` | 300000 | How often the scanner runs (≥ 60000). |
| `GMGN_DRAWDOWN_MIN_PCT` | 50 | Min % below ATH for the scanner to flag a coin. |
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
bun run gmgn:dryrun  # run one scanner cycle and print results (no Telegram, needs GMGN_API_KEY)
```

State is stored as JSON under `data/` (watchlist, subscribers, scanner dedupe).

---

## Security

- **Never commit your `.env`** — it holds your bot token (and GMGN key). It's
  gitignored, along with everything in `data/`.
- The bot is **private by default**: it refuses to start without an allowlist unless you
  explicitly set `ALLOW_OPEN_BOT=true`.
