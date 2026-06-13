import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { Bot, GrammyError, webhookCallback } from 'grammy';
import type { Update } from 'grammy/types';
import { fetchTokenSymbol } from '../fetchers/chartData';
import type { AlertPayload } from '../models/types';
import type { AlertStore } from './store';
import type { AthMonitor, AlertSink } from './athMonitor';
import type { AppConfig } from './config';
import { isChatAuthorized } from './auth';
import { escMarkdownV2 as esc, fmtPrice, fmtPct } from './format';
import { formatRichMessages } from './richFormat';
import type { RichTokenView } from './richFormat';
import type { CycleSummary } from '../gmgn/scanner';
import type { GmgnEnricher } from '../gmgn/enrich';
import type { MeteoraLinker, MeteoraPoolLink } from '../meteora/client';

/** Wrapped-SOL mint, used by /testalert as a known token with live pools. */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Runs one GMGN scan cycle on demand; null means a cycle was already running. */
export type GmgnScanTrigger = () => Promise<CycleSummary | null>;

/** base58, 32–44 chars (Solana mint). */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isValidMint = (s: string): boolean => MINT_RE.test(s);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Human-friendly "x ago" for a past epoch-ms timestamp. */
function ageString(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Injectable token-symbol lookup (defaults to the live Jupiter lookup). */
export type SymbolFetcher = (mint: string) => Promise<string | undefined>;

export interface TelegramDeps {
  fetchSymbol?: SymbolFetcher;
}

export class TelegramTransport {
  private readonly bot: Bot;
  private readonly subscribers = new Set<number>();
  private readonly fetchSymbol: SymbolFetcher;
  private webhookServer: ReturnType<typeof createServer> | null = null;
  /** Optional manual GMGN scan trigger; set only when the scanner is enabled. */
  private gmgnScan: GmgnScanTrigger | null = null;
  /** Optional GMGN enricher used to fill the rich layout for /watch alerts. */
  private gmgnEnrich: GmgnEnricher | null = null;
  /** Optional Meteora DLMM linker; adds pool links to /watch alerts. */
  private meteoraLink: MeteoraLinker | null = null;

  constructor(
    token: string,
    private readonly store: AlertStore,
    private readonly monitor: AthMonitor,
    private readonly cfg: AppConfig,
    deps: TelegramDeps = {},
  ) {
    this.bot = new Bot(token);
    this.fetchSymbol = deps.fetchSymbol ?? fetchTokenSymbol;
    this.registerAuth();
    this.registerCommands();
    this.bot.catch((err) => console.error('[telegram] bot error:', err.error));
  }

  // --- lifecycle -----------------------------------------------------------
  async init(): Promise<void> {
    if (this.cfg.allowedChatIds.length === 0) {
      console.warn(
        '[telegram] WARNING: no TELEGRAM_ALLOWED_CHAT_IDS set — the bot is OPEN; ' +
          'anyone who messages it can change watches. Set an allowlist before exposing it.',
      );
    }
    // Seed subscribers from configured chat id and from the persisted file.
    if (this.cfg.telegramChatId !== undefined) this.subscribers.add(this.cfg.telegramChatId);
    try {
      const raw = await fs.readFile(this.cfg.subscribersPath, 'utf8');
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        for (const id of arr) if (typeof id === 'number') this.subscribers.add(id);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('[telegram] could not read subscribers:', err);
      }
    }

    // Prune any subscribers that are not (or no longer) authorized, so tightening
    // the allowlist later cannot keep delivering alerts to stale/unauthorized chats.
    let pruned = 0;
    for (const id of [...this.subscribers]) {
      if (!isChatAuthorized(this.cfg.allowedChatIds, id)) {
        this.subscribers.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) {
      console.warn(`[telegram] pruned ${pruned} unauthorized subscriber(s).`);
      await this.persistSubscribers();
    }
  }

  /** Read-only snapshot of current subscriber chat IDs (for testing/inspection). */
  subscriberIds(): number[] {
    return [...this.subscribers];
  }

  /**
   * Enable the `/scan` command by wiring a manual GMGN scan trigger. Set by the
   * composition root only when the scanner is enabled; otherwise `/scan` replies
   * that the scanner is off.
   */
  setGmgnScan(trigger: GmgnScanTrigger): void {
    this.gmgnScan = trigger;
  }

  /**
   * Wire a GMGN enricher so /watch drawdown alerts are rendered with the full rich
   * layout (market cap, liquidity, holders, etc.). Best-effort: if it's unset or
   * fails, watch alerts fall back to the basic price/ATH/drawdown view.
   */
  setGmgnEnricher(enrich: GmgnEnricher): void {
    this.gmgnEnrich = enrich;
  }

  /** Wire a Meteora linker so /watch alerts include DLMM pool links (best-effort). */
  setMeteoraLinker(linker: MeteoraLinker): void {
    this.meteoraLink = linker;
  }

  /**
   * Test seam: intercept outgoing Bot API calls. The handler returns an
   * ApiResponse-like object; grammY throws a GrammyError when `ok` is false,
   * which lets tests exercise 429/403 handling without a network.
   */
  useApiInterceptor(
    handler: (method: string, payload: Record<string, unknown>) => unknown,
  ): void {
    this.bot.api.config.use(async (_prev, method, payload) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return handler(method, payload as Record<string, unknown>) as any;
    });
  }

  /** Test seam: feed a raw Telegram update through the bot's middleware/handlers. */
  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot.isInited()) await this.bot.init(); // getMe (mockable via useApiInterceptor)
    await this.bot.handleUpdate(update);
  }

  /** Remove a chat from the subscriber set (and persist). Returns true if it was present. */
  unsubscribe(chatId: number): boolean {
    const removed = this.subscribers.delete(chatId);
    if (removed) void this.persistSubscribers();
    return removed;
  }

  /**
   * Start the transport.
   * @param onFatal called if long polling dies *after* it started (e.g. a 409
   *   conflict from another running instance) so the app can shut down hard
   *   instead of leaving the monitor running against a dead Telegram connection.
   * Rejects if startup itself fails (bad token, polling never starts).
   */
  async start(onFatal?: (err: unknown) => void): Promise<void> {
    // Preflight: getMe() validates the token and Telegram reachability before we
    // start the monitor, so a bad token fails fast instead of looking "alive".
    await this.bot.init();
    console.log(`[telegram] authenticated as @${this.bot.botInfo.username}`);

    const webhookUrl = this.cfg.webhookUrl;
    if (webhookUrl) {
      const port = this.cfg.webhookPort;
      // Reject forged updates: require Telegram's secret-token header.
      const handler = webhookCallback(this.bot, 'http', {
        secretToken: this.cfg.webhookSecret,
      });
      const server = createServer((req, res) => {
        void handler(req, res).catch((e) => {
          console.error('[telegram] webhook handler error:', e);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      this.webhookServer = server;

      // Bind the port before registering the webhook; surface EADDRINUSE etc. as a
      // startup failure instead of an unhandled 'error' event that crashes later.
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onListening);
          reject(
            new Error(
              `Webhook server failed to bind port ${port}: ${err.code ?? err.message}.` +
                (err.code === 'EADDRINUSE' ? ' Is another instance running?' : ''),
            ),
          );
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          console.log(`[telegram] webhook server listening on :${port}`);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
      });

      // Keep logging post-startup server errors instead of crashing the process.
      server.on('error', (err) => console.error('[telegram] webhook server error:', err));

      await this.bot.api.setWebhook(webhookUrl, { secret_token: this.cfg.webhookSecret });
      console.log(`[telegram] webhook set → ${webhookUrl}`);
      if (!this.cfg.webhookSecret) {
        console.warn(
          '[telegram] WARNING: WEBHOOK_SECRET_TOKEN not set — webhook accepts unauthenticated POSTs.',
        );
      }
    } else {
      // Long polling. bot.start() resolves only when the bot stops, so we can't
      // await it. Instead resolve once onStart confirms polling began, and reject
      // if it fails before that. A failure *after* start (e.g. 409 conflict) is
      // routed to onFatal so the app can shut down hard rather than look alive.
      await new Promise<void>((resolve, reject) => {
        let started = false;
        this.bot
          .start({
            onStart: (info) => {
              started = true;
              console.log(`[telegram] long-polling as @${info.username}`);
              resolve();
            },
          })
          .then(() => {
            if (!started) reject(new Error('Telegram long polling stopped before it started.'));
          })
          .catch((err) => {
            if (!started) {
              reject(err instanceof Error ? err : new Error(String(err)));
            } else {
              console.error('[telegram] long-polling died:', err);
              onFatal?.(err);
            }
          });
      });
    }
  }

  async stop(): Promise<void> {
    try {
      await this.bot.stop();
    } catch {
      /* ignore */
    }
    if (this.webhookServer) {
      await new Promise<void>((resolve) => this.webhookServer!.close(() => resolve()));
      this.webhookServer = null;
    }
    await this.persistSubscribers();
  }

  // --- alert delivery ------------------------------------------------------
  /**
   * Sink for the monitor. Sends each alert batch and returns the mints that were
   * actually DELIVERED (Telegram accepted the send) to ≥ 1 authorized subscriber.
   *
   * The monitor marks only the returned mints TRIGGERED. Because TRIGGERED is
   * persisted only after delivery, an undelivered alert (no subscribers, 5xx,
   * network error, or a crash mid-send) stays ARMED and re-fires next cycle —
   * at-least-once delivery without losing alerts.
   */
  buildSink(): AlertSink {
    return async (alerts: AlertPayload[]): Promise<string[]> => {
      if (alerts.length === 0) return [];
      const views = await Promise.all(alerts.map((a) => this.buildWatchView(a)));
      const messages = formatRichMessages(views);
      const anyDelivered = await this.broadcast(messages);
      // Consumed only if at least one subscriber actually received the batch.
      return anyDelivered ? alerts.map((a) => a.mint) : [];
    };
  }

  /**
   * Build the rich view for a /watch alert. The watch framing (trigger drawdown,
   * threshold, price/ATH in the configured quote) always comes from the alert payload;
   * GMGN enrichment only fills the extra display fields and the symbol/name fallback.
   */
  private async buildWatchView(a: AlertPayload): Promise<RichTokenView> {
    const { extra, pools } = await this.fetchEnrichment(a.mint);
    return {
      ...extra,
      kind: 'watch',
      mint: a.mint,
      symbol: a.symbol ?? extra.symbol,
      chain: 'Solana',
      priceUsd: a.price,
      athUsd: a.ath,
      drawdownPct: a.drawdownPct,
      threshold: a.threshold,
      meteoraPools: pools.length > 0 ? pools : undefined,
      quote: this.cfg.quote,
    };
  }

  /**
   * Fetch the optional GMGN display fields + Meteora pool links for a mint. Both are
   * independent and best-effort, run in parallel; failures resolve to empty so an
   * alert always renders.
   */
  private async fetchEnrichment(
    mint: string,
  ): Promise<{ extra: Partial<RichTokenView>; pools: MeteoraPoolLink[] }> {
    const [extra, pools] = await Promise.all([
      this.gmgnEnrich
        ? this.gmgnEnrich(mint).catch((err) => {
            console.error(`[telegram] GMGN enrich ${mint} failed:`, err);
            return null;
          })
        : Promise.resolve(null),
      this.meteoraLink
        ? this.meteoraLink(mint).catch((err) => {
            console.error(`[telegram] Meteora links ${mint} failed:`, err);
            return [];
          })
        : Promise.resolve([]),
    ]);
    return { extra: extra ?? {}, pools };
  }

  /**
   * Render example alerts (watch + GMGN style) so a user can preview the alert layout
   * on demand via /testalert. Uses curated, internally-consistent sample stats (the
   * live GMGN record for the SOL mint is not representative of a memecoin alert), but
   * keeps the **live Meteora DLMM pool links** for the SOL mint (SOL/USDC etc.).
   */
  async processExample(chatId: number): Promise<void> {
    let pools: MeteoraPoolLink[] = [];
    if (this.meteoraLink) {
      try {
        pools = await this.meteoraLink(SOL_MINT);
      } catch (err) {
        console.error('[telegram] Meteora links (example) failed:', err);
      }
    }

    // Curated sample so the preview is always clean and complete.
    const sample: Partial<RichTokenView> = {
      mint: SOL_MINT,
      symbol: 'SOL',
      name: 'Wrapped SOL',
      chain: 'Solana',
      platform: 'Raydium',
      priceUsd: 152.34,
      fdvUsd: 72_000_000_000,
      fdvAthUsd: 122_900_000_000,
      liquidityUsd: 8_500_000,
      volumeUsd: 1_900_000_000,
      vol1hUsd: 95_000_000,
      change1hPct: -1.2,
      athUsd: 259.96,
      drawdownPct: 41.4,
      holderCount: 1_200_000,
      top10Pct: 18,
      smartMoney: { smHolding: 6, kolHolding: 3, smExited: 2, smUnrealizedPositive: 4 },
      socials: { website: 'https://solana.com', twitter: 'https://x.com/solana' },
      meteoraPools: pools.length > 0 ? pools : undefined,
    };
    const watchView: RichTokenView = { ...sample, mint: SOL_MINT, kind: 'watch', threshold: 40, quote: 'usd' };
    const gmgnView: RichTokenView = {
      ...sample,
      mint: SOL_MINT,
      kind: 'gmgn',
      verdict: 'PASS',
      warnings: [],
      hardFails: [],
      quote: 'usd',
    };

    await this.sendDirect(
      chatId,
      '🧪 *Example alerts* — sample render \\(SOL\\)\\. Preview only, not a real trigger\\.',
    );
    const messages = [...formatRichMessages([watchView]), ...formatRichMessages([gmgnView])];
    for (const m of messages) await this.sendDirect(chatId, m);
  }

  /**
   * Generic public notification path. Sends pre-rendered MarkdownV2 messages to all
   * authorized subscribers, reusing the same authorization + retry behavior as
   * {@link buildSink}. Returns true iff at least one subscriber received the batch.
   * Used by out-of-band producers (e.g. the GMGN scanner) so Telegram sending logic
   * is never duplicated.
   */
  async notify(messages: string[]): Promise<boolean> {
    if (messages.length === 0) return false;
    return this.broadcast(messages);
  }

  /**
   * Deliver a batch of MarkdownV2 messages to every currently-authorized subscriber.
   * Membership/authorization is re-checked before each send so a chat that /stop'd
   * mid-delivery is skipped. Returns true if ≥ 1 subscriber received the whole batch.
   */
  private async broadcast(messages: string[]): Promise<boolean> {
    if (messages.length === 0) return false;
    const recipients = this.authorizedSubscribers();
    if (recipients.length === 0) {
      console.warn('[telegram] notification fired but no subscribers; will retry next cycle.');
      return false;
    }
    let anyDelivered = false;
    for (let i = 0; i < recipients.length; i++) {
      const chatId = recipients[i]!;
      // Re-check membership: a user who /stop'd mid-delivery must not receive it.
      if (!this.subscribers.has(chatId) || !isChatAuthorized(this.cfg.allowedChatIds, chatId)) {
        continue;
      }
      let chatOk = true;
      for (const text of messages) {
        if (!(await this.sendWithRetry(chatId, text))) {
          chatOk = false;
          break;
        }
        if (this.cfg.sendIntervalMs > 0) await delay(this.cfg.sendIntervalMs);
      }
      if (chatOk) anyDelivered = true;
    }
    return anyDelivered;
  }

  private authorizedSubscribers(): number[] {
    return [...this.subscribers].filter((id) => isChatAuthorized(this.cfg.allowedChatIds, id));
  }

  /**
   * Send one message, awaiting Telegram's acceptance.
   * - 429: retry up to `maxRetries`, honoring `retry_after`.
   * - 403: blocked/deleted chat → drop the subscriber, return false.
   * - other GrammyError / network / 5xx → false (caller leaves the alert ARMED).
   */
  private async sendWithRetry(chatId: number, text: string, maxRetries = 3): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.bot.api.sendMessage(chatId, text, {
          parse_mode: 'MarkdownV2',
          link_preview_options: { is_disabled: true },
        });
        return true;
      } catch (err) {
        if (err instanceof GrammyError) {
          if (err.error_code === 429 && attempt < maxRetries) {
            const retryAfter = Math.max(1, err.parameters?.retry_after ?? 1);
            console.warn(`[telegram] rate-limited; retrying chat ${chatId} in ${retryAfter}s.`);
            await delay(retryAfter * 1000);
            continue;
          }
          if (err.error_code === 403) {
            console.warn(`[telegram] chat ${chatId} unreachable (403); removing subscriber.`);
            if (this.subscribers.delete(chatId)) void this.persistSubscribers();
            return false;
          }
          console.error(`[telegram] send to ${chatId} failed (${err.error_code}): ${err.description}`);
          return false;
        }
        // Network / 5xx / unknown — undelivered; alert stays ARMED to retry next cycle.
        console.error(`[telegram] send to ${chatId} failed:`, err);
        return false;
      }
    }
  }

  private async persistSubscribers(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.cfg.subscribersPath), { recursive: true });
      const tmp = `${this.cfg.subscribersPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify([...this.subscribers], null, 2), 'utf8');
      await fs.rename(tmp, this.cfg.subscribersPath);
    } catch (err) {
      console.error('[telegram] could not persist subscribers:', err);
    }
  }

  private remember(chatId: number | undefined): void {
    if (chatId === undefined) return;
    if (!this.subscribers.has(chatId)) {
      this.subscribers.add(chatId);
      void this.persistSubscribers();
    }
  }

  // --- authorization -------------------------------------------------------
  private registerAuth(): void {
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (isChatAuthorized(this.cfg.allowedChatIds, chatId)) {
        await next();
        return;
      }
      console.warn(`[telegram] rejected unauthorized chat ${chatId ?? '(unknown)'}`);
      if (ctx.chat) {
        await ctx
          .reply('⛔ You are not authorized to use this bot.')
          .catch(() => undefined);
      }
    });
  }

  // --- commands ------------------------------------------------------------
  private registerCommands(): void {
    const bot = this.bot;

    bot.command('start', async (ctx) => {
      this.remember(ctx.chat?.id);
      await ctx.reply(
        [
          '👋 *ATH Drawdown Bot*',
          'You will receive an alert when a watched token falls a set % below its rolling all\\-time high\\.',
          '',
          'Use /help to see all commands\\.',
        ].join('\n'),
        { parse_mode: 'MarkdownV2' },
      );
    });

    bot.command('stop', async (ctx) => {
      const chatId = ctx.chat?.id;
      const removed = chatId !== undefined && this.unsubscribe(chatId);
      await ctx.reply(
        removed
          ? '🔕 You are unsubscribed and will no longer receive alerts\\. Use /start to resubscribe\\.'
          : 'You were not subscribed\\.',
        { parse_mode: 'MarkdownV2' },
      );
    });

    bot.command('help', async (ctx) => {
      await ctx.reply(HELP_TEXT, { parse_mode: 'MarkdownV2' });
    });

    bot.command('watch', async (ctx) => {
      this.remember(ctx.chat?.id);
      const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      const mint = parts[0];
      if (!mint || !isValidMint(mint)) {
        await ctx.reply('Usage: `/watch <mint> [pct]` — mint must be base58, 32–44 chars\\.', {
          parse_mode: 'MarkdownV2',
        });
        return;
      }
      let threshold = this.cfg.defaultThresholdPct;
      if (parts[1] !== undefined) {
        const err = this.validateThreshold(parts[1]);
        if (err) {
          await ctx.reply(err, { parse_mode: 'MarkdownV2' });
          return;
        }
        threshold = Number(parts[1]);
      }

      // Ack immediately so webhook mode never blocks on the (slow) Jupiter call,
      // then do verification + persistence asynchronously and follow up.
      await ctx.reply('⏳ Verifying token on Jupiter…', { parse_mode: 'MarkdownV2' });
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processWatch(chatId, mint, threshold);
    });

    bot.command('unwatch', async (ctx) => {
      const mint = (ctx.match ?? '').trim().split(/\s+/)[0];
      if (!mint || !isValidMint(mint)) {
        await ctx.reply('Usage: `/unwatch <mint>`', { parse_mode: 'MarkdownV2' });
        return;
      }
      const removed = this.store.remove(mint);
      await ctx.reply(
        removed ? `🗑️ Stopped watching \`${esc(mint)}\`\\.` : 'That mint is not being watched\\.',
        { parse_mode: 'MarkdownV2' },
      );
    });

    bot.command('list', async (ctx) => {
      const entries = Object.entries(this.store.list());
      if (entries.length === 0) {
        await ctx.reply('No tokens are being watched\\. Add one with `/watch <mint>`\\.', {
          parse_mode: 'MarkdownV2',
        });
        return;
      }
      const lines = entries.map(([mint, e]) => {
        const name = e.symbol ? esc(e.symbol) : esc(`${mint.slice(0, 4)}…${mint.slice(-4)}`);
        let line = `• *${name}* \`${esc(mint)}\` — ${esc(fmtPct(e.threshold))}% \\[${e.state}\\]`;
        if (e.lastDrawdownPct !== undefined) {
          line += `\n   ↳ now ${esc(fmtPct(e.lastDrawdownPct))}% down`;
          if (e.lastCheckedAt) line += ` · ${esc(ageString(e.lastCheckedAt))}`;
          if (e.lastStale) line += ' · ⚠️ stale';
        } else {
          line += '\n   ↳ _not checked yet_';
        }
        return line;
      });
      await ctx.reply(['*Watched tokens:*', ...lines].join('\n'), { parse_mode: 'MarkdownV2' });
    });

    bot.command('threshold', async (ctx) => {
      const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      const target = parts[0];
      const pctStr = parts[1];
      if (!target || pctStr === undefined) {
        await ctx.reply('Usage: `/threshold <mint|all> <pct>`', { parse_mode: 'MarkdownV2' });
        return;
      }
      const err = this.validateThreshold(pctStr);
      if (err) {
        await ctx.reply(err, { parse_mode: 'MarkdownV2' });
        return;
      }
      const pct = Number(pctStr);
      if (target.toLowerCase() === 'all') {
        const n = this.store.setThresholdAll(pct);
        await ctx.reply(`Updated *${n}* token\\(s\\) to *${esc(fmtPct(pct))}%*\\.`, {
          parse_mode: 'MarkdownV2',
        });
        return;
      }
      if (!isValidMint(target)) {
        await ctx.reply('Mint must be base58, 32–44 chars \\(or `all`\\)\\.', {
          parse_mode: 'MarkdownV2',
        });
        return;
      }
      const ok = this.store.setThreshold(target, pct);
      await ctx.reply(
        ok
          ? `✅ \`${esc(target)}\` threshold set to *${esc(fmtPct(pct))}%*\\.`
          : 'That mint is not being watched\\.',
        { parse_mode: 'MarkdownV2' },
      );
    });

    bot.command('status', async (ctx) => {
      const mint = (ctx.match ?? '').trim().split(/\s+/)[0];
      if (!mint || !isValidMint(mint)) {
        await ctx.reply('Usage: `/status <mint>`', { parse_mode: 'MarkdownV2' });
        return;
      }
      // Ack immediately; fetch + reply asynchronously so webhook mode stays responsive.
      await ctx.reply('⏳ Fetching…', { parse_mode: 'MarkdownV2' });
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processStatus(chatId, mint);
    });

    bot.command('resetath', async (ctx) => {
      const mint = (ctx.match ?? '').trim().split(/\s+/)[0];
      if (!mint || !isValidMint(mint)) {
        await ctx.reply('Usage: `/resetath <mint>`', { parse_mode: 'MarkdownV2' });
        return;
      }
      const ok = this.store.resetAth(mint);
      await ctx.reply(
        ok
          ? `♻️ Reset stored ATH for \`${esc(mint)}\` \\(re\\-armed\\)\\.`
          : 'That mint is not being watched\\.',
        { parse_mode: 'MarkdownV2' },
      );
    });

    bot.command('scan', async (ctx) => {
      this.remember(ctx.chat?.id);
      if (!this.gmgnScan) {
        await ctx.reply(
          'GMGN scanner is not enabled\\. Set `GMGN_SCAN_ENABLED=true` \\(and `GMGN_API_KEY`\\) to use this\\.',
          { parse_mode: 'MarkdownV2' },
        );
        return;
      }
      // Ack immediately; the cycle can take several seconds (rank + per-token detail).
      await ctx.reply('⏳ Running a GMGN scan cycle…', { parse_mode: 'MarkdownV2' });
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processScan(chatId);
    });

    bot.command('testalert', async (ctx) => {
      this.remember(ctx.chat?.id);
      // Ack immediately; enrichment (GMGN + Meteora) can take a moment.
      await ctx.reply('🧪 Building an example alert…', { parse_mode: 'MarkdownV2' });
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processExample(chatId);
    });
  }

  /** Async body of /scan: run one GMGN cycle, then follow up with the counts. */
  async processScan(chatId: number): Promise<void> {
    if (!this.gmgnScan) return;
    let summary: CycleSummary | null;
    try {
      summary = await this.gmgnScan();
    } catch (err) {
      console.error('[telegram] /scan failed:', err);
      await this.sendDirect(chatId, 'GMGN scan failed; check the logs and try again later\\.');
      return;
    }
    if (summary === null) {
      await this.sendDirect(
        chatId,
        '⏳ A scan is already running — its results will arrive shortly\\.',
      );
      return;
    }
    const lines = [
      '🔎 *GMGN scan complete*',
      `Trending: ${summary.trending}  ·  Quick\\-pass: ${summary.quickPass}`,
      `Base\\-pass: ${summary.basePass}  ·  Deliverable: ${summary.deliverable}`,
      summary.fresh === 0
        ? 'No new candidates \\(already alerted or none matched\\)\\.'
        : summary.delivered
          ? `✅ Sent *${summary.fresh}* new alert\\(s\\)\\.`
          : `⚠️ *${summary.fresh}* new candidate\\(s\\) found but delivery failed — will retry next cycle\\.`,
    ];
    await this.sendDirect(chatId, lines.join('\n'));
  }

  /** Send a one-off MarkdownV2 message directly (command replies; not the alert queue). */
  private async sendDirect(chatId: number, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error(`[telegram] reply to ${chatId} failed:`, err);
    }
  }

  /** Async body of /watch: verify on Jupiter, then persist + follow up. */
  async processWatch(chatId: number, mint: string, threshold: number): Promise<void> {
    let snap;
    try {
      snap = await this.monitor.snapshot(mint);
    } catch (err) {
      console.error(`[telegram] /watch snapshot ${mint} failed:`, err);
      await this.sendDirect(chatId, 'Could not reach Jupiter to verify that token; try again later\\.');
      return;
    }
    if (!snap || !(snap.ath > 0)) {
      await this.sendDirect(
        chatId,
        'No market data found for that mint — it was *not* added\\. Double\\-check the address\\.',
      );
      return;
    }
    const symbol = await this.fetchSymbol(mint);
    this.store.upsertWatch(mint, threshold, { symbol });
    // updatePersistedAth owns quote: for an existing watch in another denomination
    // this rebases ATH + quote together (no stale-denomination corruption).
    this.store.updatePersistedAth(mint, snap.ath, this.cfg.quote);

    const label = symbol ? `*${esc(symbol)}* ` : '';
    await this.sendDirect(
      chatId,
      `✅ Watching ${label}\`${esc(mint)}\` at *${esc(fmtPct(threshold))}%* drawdown\\.\n` +
        `Current drawdown: ${esc(fmtPct(snap.drawdownPct))}%`,
    );
  }

  /** Async body of /status: fetch a snapshot, then follow up. */
  async processStatus(chatId: number, mint: string): Promise<void> {
    const entry = this.store.get(mint);
    let snap;
    try {
      snap = await this.monitor.snapshot(mint);
    } catch (err) {
      console.error('[telegram] /status failed:', err);
      await this.sendDirect(chatId, 'Failed to fetch status, try again later\\.');
      return;
    }
    if (!snap) {
      await this.sendDirect(chatId, 'No data returned for that mint\\.');
      return;
    }
    const quote = this.cfg.quote === 'usd' ? 'USD' : 'SOL';
    const lines = [
      `*Status* \`${esc(mint)}\``,
      `Price: ${esc(fmtPrice(snap.price))} ${quote}`,
      `ATH \\(rolling\\): ${esc(fmtPrice(snap.ath))} ${quote}`,
      `Drawdown: *${esc(fmtPct(snap.drawdownPct))}%*`,
    ];
    if (entry) {
      lines.push(`Threshold: ${esc(fmtPct(entry.threshold))}%  ·  State: ${entry.state}`);
      if (entry.lastCheckedAt) {
        lines.push(`Last check: ${esc(ageString(entry.lastCheckedAt))}`);
      }
    } else {
      lines.push('_Not currently watched_\\.');
    }
    if (snap.stale) lines.push('⚠️ _Latest candle looks stale; data may be delayed_\\.');
    await this.sendDirect(chatId, lines.join('\n'));
  }

  /** Returns a MarkdownV2 error string if the threshold is invalid, else null. */
  private validateThreshold(pctStr: string): string | null {
    const pct = Number(pctStr);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return 'Threshold must be a number in \\(0, 100\\]\\.';
    }
    if (pct <= this.cfg.recoveryHysteresisPct) {
      return (
        `Threshold must be greater than the recovery hysteresis ` +
        `\\(${esc(fmtPct(this.cfg.recoveryHysteresisPct))}%\\), otherwise alerts can never re\\-arm\\.`
      );
    }
    return null;
  }
}

const HELP_TEXT = [
  '*Commands*',
  '/start — subscribe this chat to alerts',
  '/stop — unsubscribe this chat from alerts',
  '/watch `<mint>` `[pct]` — watch a token \\(verified on Jupiter first\\)',
  '/unwatch `<mint>` — stop watching',
  '/list — list watched tokens',
  '/threshold `<mint|all>` `<pct>` — set drawdown threshold',
  '/status `<mint>` — current price, rolling ATH and drawdown',
  '/resetath `<mint>` — reset the stored ATH and re\\-arm',
  '/scan — run a GMGN drawdown scan cycle now \\(if the scanner is enabled\\)',
  '/testalert — preview an example alert \\(rendered for SOL\\)',
  '/help — this message',
].join('\n');
