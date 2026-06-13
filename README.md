# ATH Drawdown Bot

A Telegram bot for Solana tokens that alerts you when a coin drops a set percentage
below its all‑time high (ATH) — and renders a rich, at‑a‑glance card for any token on
demand.

Built with **Bun** + **TypeScript** + **grammY**, using the **Jupiter**, **GMGN**, and
**Meteora** APIs.

---

## What it does

- 🔻 **Drawdown alerts** — `/watch` a token and get pinged the moment it falls a
  configurable % below its rolling ATH.
- 🔍 **On‑demand cards** — `/check <mint>` shows a full token card (price, market cap,
  liquidity, holders, smart‑money, DLMM pools…) for any token, instantly.
- 🔎 **Drawdown scanner** *(optional)* — a background cron that hunts for coins deep in
  drawdown but still alive, screens them for safety, and alerts on the survivors.

Every alert and card links the token name to **GMGN**, lists its top **Meteora DLMM
pools**, and works in both DMs and **group chats** (replies tag whoever ran the command).

---

## Example card

```
🔍 drooling cat  [$1.38M]  [⬇️50.31%]  $DROOLING

🏔 ATH: $2.76M

🌐 Solana @ Pump.fun
💰 USD: 0.00137138
💎 FDV: $1.38M ⇨ $2.76M
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

**Requirements:** [Bun](https://bun.sh) and a Telegram bot token from
[@BotFather](https://t.me/BotFather).

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
```

> Don't know your chat id? Message [@userinfobot](https://t.me/userinfobot). The
> allowlist keeps your bot private — only listed chats can use it.

Run it:

```bash
bun run start
```

Then in Telegram: send **`/start`**, then **`/watch <token_mint>`**. That's it — you'll
get an alert when the token is 50% below its ATH (change the threshold per token, e.g.
`/watch <mint> 40`).

To add the bot to a **group**, just invite it and have members run commands there.

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
| `/scan` | Run the drawdown scanner now *(if enabled)* |
| `/gmgnstatus` | Last scanner run summary *(if enabled)* |
| `/testalert` | Preview what an alert looks like |
| `/help` | List all commands |

All commands also appear in Telegram's **Menu** button and `/` autocomplete.

---

## Optional: GMGN data & scanner

The bot works out of the box with Jupiter price data. Adding a **GMGN OpenAPI key**
unlocks the rich card data (market cap, liquidity, holders, smart‑money) for `/watch`
and `/check`, and lets you enable the background scanner:

```env
GMGN_API_KEY=your-gmgn-key       # enriches /watch and /check cards
GMGN_SCAN_ENABLED=true           # also turn on the background drawdown scanner
```

When enabled, the scanner periodically pulls trending Solana coins, keeps the ones that
are deep in drawdown with real activity, screens them (renounce status, rug/holder
concentration, snipers, bundlers, wash‑trading, smart‑money), and sends a screening
alert for the ones that pass. Tune it with the `GMGN_*` variables in `.env.example`.

**Meteora DLMM pool links** are shown automatically (public API, no key required); turn
them off with `METEORA_LINKS_ENABLED=false`.

---

## Configuration

The most common settings:

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Your BotFather token. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | Allowed chat ids (keeps the bot private). |
| `DEFAULT_DRAWDOWN_THRESHOLD_PCT` | 50 | Default alert threshold. |
| `QUOTE` | native | `native` (SOL) or `usd` for the watch price/ATH. |
| `POLL_INTERVAL_MS` | 60000 | How often watched tokens are checked. |
| `GMGN_API_KEY` | — | Enables GMGN card data and the scanner. |
| `GMGN_SCAN_ENABLED` | false | Turn the background scanner on. |
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
