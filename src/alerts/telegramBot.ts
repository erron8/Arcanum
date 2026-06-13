import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { Bot, Context, GrammyError, webhookCallback } from 'grammy';
import type { Update, BotCommand } from 'grammy/types';
import { fetchTokenSymbol } from '../fetchers/chartData';
import type { AlertPayload } from '../models/types';
import type { AlertStore } from './store';
import type { AthMonitor, AlertSink } from './athMonitor';
import type { AppConfig } from './config';
import { isChatAuthorized } from './auth';
import { escMarkdownV2 as esc, fmtPrice, fmtPct } from './format';
import { formatRichMessages } from './richFormat';
import type { RichTokenView } from './richFormat';
import type { CycleSummary, GmgnScanStatus } from '../gmgn/scanner';
import type { GmgnEnricher } from '../gmgn/enrich';
import type { MeteoraLinker, MeteoraPoolLink } from '../meteora/client';

/** Wrapped-SOL mint, used by /testalert as a known token with live pools. */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Runs one GMGN scan cycle on demand; null means a cycle was already running. */
export type GmgnScanTrigger = () => Promise<CycleSummary | null>;

/** Returns a snapshot of recent GMGN scanner activity for /gmgnstatus. */
export type GmgnStatusProvider = () => GmgnScanStatus;

/**
 * Default cap on how long a /watch alert waits for GMGN + Meteora enrichment before
 * sending the basic alert anyway. Critical alerts must not be delayed by slow lookups.
 */
const ENRICH_TIMEOUT_MS = 2_500;

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
  /** Override the /watch enrichment timeout (ms). Defaults to ENRICH_TIMEOUT_MS. */
  enrichTimeoutMs?: number;
}

/**
 * Resolve `p`, but fall back to `fallback` if it doesn't settle within `ms`. A
 * rejected promise also yields the fallback. Used to bound best-effort enrichment so
 * a slow upstream never delays a critical alert.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (v: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    p.then(
      (v) => finish(v),
      () => finish(fallback),
    );
  });
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
  /** Optional GMGN scanner status provider; enables /gmgnstatus. */
  private gmgnStatus: GmgnStatusProvider | null = null;
  private readonly enrichTimeoutMs: number;

  constructor(
    token: string,
    private readonly store: AlertStore,
    private readonly monitor: AthMonitor,
    private readonly cfg: AppConfig,
    deps: TelegramDeps = {},
  ) {
    this.bot = new Bot(token);
    this.fetchSymbol = deps.fetchSymbol ?? fetchTokenSymbol;
    this.enrichTimeoutMs = deps.enrichTimeoutMs ?? ENRICH_TIMEOUT_MS;
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

  /** Wire a GMGN scanner status provider, enabling the /gmgnstatus command. */
  setGmgnStatus(provider: GmgnStatusProvider): void {
    this.gmgnStatus = provider;
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

    // Publish the command menu (the list shown when a user types "/" or taps Menu).
    // Best-effort: a failure here must not block startup.
    try {
      await this.bot.api.setMyCommands(this.commandMenu());
    } catch (err) {
      console.warn('[telegram] could not set command menu:', err);
    }

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
   * independent and best-effort, run in parallel, and each is bounded by
   * `enrichTimeoutMs` so a slow upstream can't delay the alert: on timeout (or error)
   * the field is simply omitted and the alert still renders/sends.
   */
  private async fetchEnrichment(
    mint: string,
  ): Promise<{ extra: Partial<RichTokenView>; pools: MeteoraPoolLink[] }> {
    const ms = this.enrichTimeoutMs;
    const extraP: Promise<Partial<RichTokenView> | null> = this.gmgnEnrich
      ? withTimeout(
          this.gmgnEnrich(mint).catch((err) => {
            console.error(`[telegram] GMGN enrich ${mint} failed:`, err);
            return null;
          }),
          ms,
          null,
        )
      : Promise.resolve(null);
    const poolsP: Promise<MeteoraPoolLink[]> = this.meteoraLink
      ? withTimeout(
          this.meteoraLink(mint).catch((err) => {
            console.error(`[telegram] Meteora links ${mint} failed:`, err);
            return [];
          }),
          ms,
          [],
        )
      : Promise.resolve([]);
    const [extra, pools] = await Promise.all([extraP, poolsP]);
    return { extra: extra ?? {}, pools };
  }

  /**
   * Render example alerts (watch + GMGN style) so a user can preview the alert layout
   * on demand via /testalert. Uses curated, internally-consistent sample stats (the
   * live GMGN record for the SOL mint is not representative of a memecoin alert), but
   * keeps the **live Meteora DLMM pool links** for the SOL mint (SOL/USDC etc.).
   */
  async processExample(chatId: number, replyTo?: number): Promise<void> {
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
      replyTo,
    );
    const messages = [...formatRichMessages([watchView]), ...formatRichMessages([gmgnView])];
    for (const m of messages) await this.sendDirect(chatId, m, replyTo);
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

  /**
   * The command menu published to Telegram via setMyCommands — the list users see
   * when they type "/" or tap the Menu button. Descriptions are plain text (no
   * MarkdownV2) and kept short. Exposed for inspection/testing.
   */
  commandMenu(): BotCommand[] {
    return [
      { command: 'start', description: 'Subscribe this chat to alerts' },
      { command: 'watch', description: 'Watch a token: /watch <mint> [pct]' },
      { command: 'unwatch', description: 'Stop watching a token: /unwatch <mint>' },
      { command: 'list', description: 'List watched tokens' },
      { command: 'threshold', description: 'Set drawdown threshold: /threshold <mint|all> <pct>' },
      { command: 'status', description: 'Token price, ATH and drawdown: /status <mint>' },
      { command: 'check', description: 'Full token card for any mint: /check <mint>' },
      { command: 'resetath', description: 'Reset stored ATH and re-arm: /resetath <mint>' },
      { command: 'scan', description: 'Run a GMGN drawdown scan now' },
      { command: 'gmgnstatus', description: 'Show the last GMGN scan summary' },
      { command: 'testalert', description: 'Preview an example alert' },
      { command: 'stop', description: 'Unsubscribe this chat from alerts' },
      { command: 'help', description: 'Show all commands' },
    ];
  }

  // --- commands ------------------------------------------------------------
  private registerCommands(): void {
    const bot = this.bot;

    bot.command('start', async (ctx) => {
      this.remember(ctx.chat?.id);
      await this.replyTo(
        ctx,
        [
          '👋 *ATH Drawdown Bot*',
          '',
          'I ping you the moment a token you watch drops a set % below its rolling all\\-time high\\.',
          '',
          '🚀 *Get started*',
          '   📈  /watch `<mint>` — watch a token',
          '   🔍  /check `<mint>` — full token card',
          '   📋  /list — your watchlist',
          '   ❓  /help — see every command',
          '',
          '🔔 You are now subscribed to alerts\\.',
        ].join('\n'),
      );
    });

    bot.command('stop', async (ctx) => {
      const chatId = ctx.chat?.id;
      const removed = chatId !== undefined && this.unsubscribe(chatId);
      await this.replyTo(
        ctx,
        removed
          ? ['🔕 *Unsubscribed*', '', 'You are unsubscribed and will no longer receive alerts\\.', 'Use /start to resubscribe\\.'].join('\n')
          : 'ℹ️ You were not subscribed\\.',
      );
    });

    bot.command('help', async (ctx) => {
      await this.replyTo(ctx, HELP_TEXT);
    });

    bot.command('watch', async (ctx) => {
      this.remember(ctx.chat?.id);
      const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      const mint = parts[0];
      if (!mint || !isValidMint(mint)) {
        await this.replyTo(
          ctx,
          ['ℹ️ *Usage*  `/watch <mint> [pct]`', '', 'The mint must be base58, 32–44 chars\\.'].join('\n'),
        );
        return;
      }
      let threshold = this.cfg.defaultThresholdPct;
      if (parts[1] !== undefined) {
        const err = this.validateThreshold(parts[1]);
        if (err) {
          await this.replyTo(ctx, err);
          return;
        }
        threshold = Number(parts[1]);
      }

      // Ack immediately so webhook mode never blocks on the (slow) Jupiter call,
      // then do verification + persistence asynchronously and follow up.
      await this.replyTo(ctx, '⏳ Verifying token on Jupiter…');
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processWatch(chatId, mint, threshold, ctx.msgId);
    });

    bot.command('unwatch', async (ctx) => {
      const mint = (ctx.match ?? '').trim().split(/\s+/)[0];
      if (!mint || !isValidMint(mint)) {
        await this.replyTo(ctx, 'ℹ️ *Usage*  `/unwatch <mint>`');
        return;
      }
      const removed = this.store.remove(mint);
      await this.replyTo(
        ctx,
        removed
          ? ['🗑️ *Stopped watching*', '', `\`${esc(mint)}\``].join('\n')
          : 'ℹ️ That mint is not on your watchlist\\.',
      );
    });

    bot.command('list', async (ctx) => {
      const entries = Object.entries(this.store.list());
      if (entries.length === 0) {
        await this.replyTo(
          ctx,
          ['📋 *Watched tokens*', '', 'Your watchlist is empty\\.', 'Add one with `/watch <mint>`\\.'].join('\n'),
        );
        return;
      }
      const blocks = entries.map(([mint, e]) => {
        const name = e.symbol ? esc(e.symbol) : esc(`${mint.slice(0, 4)}…${mint.slice(-4)}`);
        const stateIcon = e.state === 'TRIGGERED' ? '🔴' : '🟢';
        let block = `${stateIcon} *${name}*  ·  🎯 ${esc(fmtPct(e.threshold))}%\n\`${esc(mint)}\``;
        if (e.lastDrawdownPct !== undefined) {
          let line = `   ↳ 📉 now ${esc(fmtPct(e.lastDrawdownPct))}% down`;
          if (e.lastCheckedAt) line += `  ·  🕒 ${esc(ageString(e.lastCheckedAt))}`;
          if (e.lastStale) line += '  ·  ⚠️ stale';
          block += `\n${line}`;
        } else {
          block += '\n   ↳ _not checked yet_';
        }
        return block;
      });
      const header = `📋 *Watched tokens* \\(${entries.length}\\)`;
      await this.replyTo(ctx, [header, ...blocks].join('\n\n'));
    });

    bot.command('threshold', async (ctx) => {
      const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
      const target = parts[0];
      const pctStr = parts[1];
      if (!target || pctStr === undefined) {
        await this.replyTo(ctx, 'ℹ️ *Usage*  `/threshold <mint|all> <pct>`');
        return;
      }
      const err = this.validateThreshold(pctStr);
      if (err) {
        await this.replyTo(ctx, err);
        return;
      }
      const pct = Number(pctStr);
      if (target.toLowerCase() === 'all') {
        const n = this.store.setThresholdAll(pct);
        await this.replyTo(ctx, `🎯 Updated *${n}* token\\(s\\) to *${esc(fmtPct(pct))}%* drawdown\\.`);
        return;
      }
      if (!isValidMint(target)) {
        await this.replyTo(ctx, 'ℹ️ Mint must be base58, 32–44 chars \\(or `all`\\)\\.');
        return;
      }
      const ok = this.store.setThreshold(target, pct);
      await this.replyTo(
        ctx,
        ok
          ? ['🎯 *Threshold updated*', '', `\`${esc(target)}\``, `Now alerting at *${esc(fmtPct(pct))}%* drawdown\\.`].join('\n')
          : 'ℹ️ That mint is not on your watchlist\\.',
      );
    });

    bot.command('status', async (ctx) => {
      const mint = (ctx.match ?? '').trim().split(/\s+/)[0];
      if (!mint || !isValidMint(mint)) {
        await this.replyTo(ctx, 'ℹ️ *Usage*  `/status <mint>`');
        return;
      }
      // Ack immediately; fetch + reply asynchronously so webhook mode stays responsive.
      await this.replyTo(ctx, '⏳ Fetching…');
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processStatus(chatId, mint, ctx.msgId);
    });

    bot.command('check', async (ctx) => {
      this.remember(ctx.chat?.id);
      const mint = (ctx.match ?? '').trim().split(/\s+/)[0];
      if (!mint || !isValidMint(mint)) {
        await this.replyTo(
          ctx,
          ['ℹ️ *Usage*  `/check <mint>`', '', 'Shows the full token card \\(market cap, holders, pools…\\)\\.'].join('\n'),
        );
        return;
      }
      // Ack immediately; the full lookup (Jupiter + GMGN + Meteora) can take a moment.
      await this.replyTo(ctx, '🔍 Fetching token details…');
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processCheck(chatId, mint, ctx.msgId);
    });

    bot.command('resetath', async (ctx) => {
      const mint = (ctx.match ?? '').trim().split(/\s+/)[0];
      if (!mint || !isValidMint(mint)) {
        await this.replyTo(ctx, 'ℹ️ *Usage*  `/resetath <mint>`');
        return;
      }
      const ok = this.store.resetAth(mint);
      await this.replyTo(
        ctx,
        ok
          ? ['♻️ *ATH reset & re\\-armed*', '', `\`${esc(mint)}\``].join('\n')
          : 'ℹ️ That mint is not on your watchlist\\.',
      );
    });

    bot.command('scan', async (ctx) => {
      this.remember(ctx.chat?.id);
      if (!this.gmgnScan) {
        await this.replyTo(
          ctx,
          ['🛑 *GMGN scanner is not enabled*', '', 'Set `GMGN_SCAN_ENABLED=true` and `GMGN_API_KEY` to use this\\.'].join('\n'),
        );
        return;
      }
      // Ack immediately; the cycle can take several seconds (rank + per-token detail).
      await this.replyTo(ctx, '⏳ Running a GMGN scan cycle…');
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processScan(chatId, ctx.msgId);
    });

    bot.command('gmgnstatus', async (ctx) => {
      this.remember(ctx.chat?.id);
      await this.replyTo(ctx, this.gmgnStatusText());
    });

    bot.command('testalert', async (ctx) => {
      this.remember(ctx.chat?.id);
      // Ack immediately; enrichment (GMGN + Meteora) can take a moment.
      await this.replyTo(ctx, '🧪 Building an example alert…');
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) void this.processExample(chatId, ctx.msgId);
    });
  }

  /** Build the MarkdownV2 reply for /gmgnstatus from the scanner status provider. */
  private gmgnStatusText(): string {
    if (!this.gmgnStatus) {
      return ['🛑 *GMGN scanner is not enabled*', '', 'Set `GMGN_SCAN_ENABLED=true` and `GMGN_API_KEY` to use this\\.'].join('\n');
    }
    const s = this.gmgnStatus();
    const lines: string[] = ['📊 *GMGN scanner status*', ''];
    lines.push(s.scanning ? '⚙️ State: _scanning…_' : '💤 State: idle');

    if (s.lastSummary && s.lastSummaryAt !== null) {
      const m = s.lastSummary;
      lines.push(`🕒 Last scan: ${esc(ageString(s.lastSummaryAt))}`);
      lines.push('');
      lines.push(`📈 Trending: *${m.trending}*  ·  ⚡ Quick\\-pass: *${m.quickPass}*`);
      lines.push(`✅ Base\\-pass: *${m.basePass}*  ·  📨 Deliverable: *${m.deliverable}*`);
      lines.push(`🆕 New: *${m.fresh}*  ·  📤 Delivered: ${m.delivered ? '✅ yes' : '— no'}`);
      if (m.baseDropSummary) {
        lines.push(`🪧 Base\\-drops: ${esc(m.baseDropSummary)}`);
      }
    } else {
      lines.push('');
      lines.push('_No scan has completed yet\\._');
    }

    if (s.lastDelivered) {
      const d = s.lastDelivered;
      const label = d.symbol ? `*${esc(d.symbol)}* ` : '';
      lines.push('');
      lines.push(`🏷️ Last delivered: ${label}\`${esc(d.mint)}\` \\(${esc(ageString(d.at))}\\)`);
    }
    if (s.lastError) {
      lines.push('');
      lines.push(`⚠️ Last error: ${esc(s.lastError.message)} \\(${esc(ageString(s.lastError.at))}\\)`);
    }
    return lines.join('\n');
  }

  /** Async body of /scan: run one GMGN cycle, then follow up with the counts. */
  async processScan(chatId: number, replyTo?: number): Promise<void> {
    if (!this.gmgnScan) return;
    let summary: CycleSummary | null;
    try {
      summary = await this.gmgnScan();
    } catch (err) {
      console.error('[telegram] /scan failed:', err);
      await this.sendDirect(chatId, '❌ GMGN scan failed; check the logs and try again later\\.', replyTo);
      return;
    }
    if (summary === null) {
      await this.sendDirect(
        chatId,
        '⏳ A scan is already running — its results will arrive shortly\\.',
        replyTo,
      );
      return;
    }
    const lines = [
      '🔎 *GMGN scan complete*',
      '',
      `📈 Trending: *${summary.trending}*  ·  ⚡ Quick\\-pass: *${summary.quickPass}*`,
      `✅ Base\\-pass: *${summary.basePass}*  ·  📨 Deliverable: *${summary.deliverable}*`,
      '',
      summary.fresh === 0
        ? '😴 No new candidates \\(already alerted or none matched\\)\\.'
        : summary.delivered
          ? `🚀 Sent *${summary.fresh}* new alert\\(s\\)\\.`
          : `⚠️ *${summary.fresh}* new candidate\\(s\\) found but delivery failed — will retry next cycle\\.`,
    ];
    // Surface why candidates dropped at the base filter, even when some passed.
    if (summary.baseDropSummary) {
      lines.push(`🪧 Base\\-drops: ${esc(summary.baseDropSummary)}`);
    }
    await this.sendDirect(chatId, lines.join('\n'), replyTo);
  }

  /**
   * Reply to the message that triggered a command, threading the reply so the calling
   * user is highlighted/notified (important in group chats). Falls back to a normal
   * send if the original message id is unavailable.
   */
  private async replyTo(ctx: Context, text: string): Promise<void> {
    const msgId = ctx.msgId;
    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
      ...(msgId !== undefined
        ? { reply_parameters: { message_id: msgId, allow_sending_without_reply: true } }
        : {}),
    });
  }

  /**
   * Send a one-off MarkdownV2 message directly (async command follow-ups; not the
   * alert queue). When `replyToMessageId` is given the message is threaded as a reply
   * to the user's command, so they get tagged in group chats.
   */
  private async sendDirect(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
        ...(replyToMessageId !== undefined
          ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
          : {}),
      });
    } catch (err) {
      console.error(`[telegram] reply to ${chatId} failed:`, err);
    }
  }

  /** Async body of /watch: verify on Jupiter, then persist + follow up. */
  async processWatch(chatId: number, mint: string, threshold: number, replyTo?: number): Promise<void> {
    let snap;
    try {
      snap = await this.monitor.snapshot(mint);
    } catch (err) {
      console.error(`[telegram] /watch snapshot ${mint} failed:`, err);
      await this.sendDirect(chatId, '⚠️ Could not reach Jupiter to verify that token — try again later\\.', replyTo);
      return;
    }
    if (!snap || !(snap.ath > 0)) {
      await this.sendDirect(
        chatId,
        ['🔍 *No market data found*', '', 'That mint was *not* added — double\\-check the address\\.'].join('\n'),
        replyTo,
      );
      return;
    }
    const symbol = await this.fetchSymbol(mint);
    this.store.upsertWatch(mint, threshold, { symbol });
    // updatePersistedAth owns quote: for an existing watch in another denomination
    // this rebases ATH + quote together (no stale-denomination corruption).
    this.store.updatePersistedAth(mint, snap.ath, this.cfg.quote);

    const label = symbol ? `*${esc(symbol)}*  ` : '';
    await this.sendDirect(
      chatId,
      [
        `✅ *Watching* ${label}`,
        `\`${esc(mint)}\``,
        '',
        `🎯 Alert at: *${esc(fmtPct(threshold))}%* drawdown`,
        `📉 Current drawdown: *${esc(fmtPct(snap.drawdownPct))}%*`,
      ].join('\n'),
      replyTo,
    );
  }

  /** Async body of /status: fetch a snapshot, then follow up. */
  async processStatus(chatId: number, mint: string, replyTo?: number): Promise<void> {
    const entry = this.store.get(mint);
    let snap;
    try {
      snap = await this.monitor.snapshot(mint);
    } catch (err) {
      console.error('[telegram] /status failed:', err);
      await this.sendDirect(chatId, '⚠️ Failed to fetch status — try again later\\.', replyTo);
      return;
    }
    if (!snap) {
      await this.sendDirect(chatId, 'ℹ️ No data returned for that mint\\.', replyTo);
      return;
    }
    const quote = this.cfg.quote === 'usd' ? 'USD' : 'SOL';
    const lines = [
      '📊 *Status*',
      `\`${esc(mint)}\``,
      '',
      `💰 Price: *${esc(fmtPrice(snap.price))}* ${quote}`,
      `🏔 ATH \\(rolling\\): ${esc(fmtPrice(snap.ath))} ${quote}`,
      `📉 Drawdown: *${esc(fmtPct(snap.drawdownPct))}%*`,
    ];
    if (entry) {
      const stateIcon = entry.state === 'TRIGGERED' ? '🔴' : '🟢';
      lines.push('');
      lines.push(`🎯 Threshold: ${esc(fmtPct(entry.threshold))}%  ·  ${stateIcon} ${entry.state}`);
      if (entry.lastCheckedAt) {
        lines.push(`🕒 Last check: ${esc(ageString(entry.lastCheckedAt))}`);
      }
    } else {
      lines.push('');
      lines.push('_Not currently watched\\._');
    }
    if (snap.stale) lines.push('⚠️ _Latest candle looks stale; data may be delayed_\\.');
    await this.sendDirect(chatId, lines.join('\n'), replyTo);
  }

  /**
   * Async body of /check: render the full token card (same rich layout as an alert)
   * for any mint on demand. Uses the Jupiter snapshot for price/ATH/drawdown and
   * merges GMGN display fields + Meteora pools; best-effort, so partial data still shows.
   */
  async processCheck(chatId: number, mint: string, replyTo?: number): Promise<void> {
    const [snap, { extra, pools }] = await Promise.all([
      this.monitor.snapshot(mint).catch((err) => {
        console.error(`[telegram] /check snapshot ${mint} failed:`, err);
        return null;
      }),
      this.fetchEnrichment(mint),
    ]);

    // Prefer GMGN USD data so the card is internally consistent: USD price + USD
    // market caps, and a drawdown computed from the USD ATH (matches the FDV ⇨ ATH
    // projection). Fall back to the Jupiter snapshot only when GMGN has no price.
    let priceUsd = extra.priceUsd;
    let athUsd = extra.athUsd;
    let drawdownPct: number | undefined;
    let quote: 'native' | 'usd' = 'usd';
    if (priceUsd !== undefined) {
      if (athUsd !== undefined && athUsd > 0) {
        drawdownPct = Math.max(0, ((athUsd - priceUsd) / athUsd) * 100);
      } else if (snap) {
        drawdownPct = snap.drawdownPct;
      }
    } else if (snap) {
      priceUsd = snap.price;
      athUsd = snap.ath;
      drawdownPct = snap.drawdownPct;
      quote = this.cfg.quote;
    }

    const hasAnything =
      priceUsd !== undefined || pools.length > 0 || Object.keys(extra).length > 0;
    if (!hasAnything) {
      await this.sendDirect(
        chatId,
        ['🔍 *No data found*', '', `\`${esc(mint)}\``, '', 'Could not find market data for that mint\\.'].join('\n'),
        replyTo,
      );
      return;
    }

    const view: RichTokenView = {
      ...extra,
      kind: 'check',
      mint,
      symbol: extra.symbol,
      chain: 'Solana',
      priceUsd,
      athUsd,
      drawdownPct,
      meteoraPools: pools.length > 0 ? pools : undefined,
      quote,
    };
    const messages = formatRichMessages([view]);
    for (const m of messages) await this.sendDirect(chatId, m, replyTo);
  }

  /** Returns a MarkdownV2 error string if the threshold is invalid, else null. */
  private validateThreshold(pctStr: string): string | null {
    const pct = Number(pctStr);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return '⚠️ Threshold must be a number in \\(0, 100\\]\\.';
    }
    if (pct <= this.cfg.recoveryHysteresisPct) {
      return (
        `⚠️ Threshold must be greater than the recovery hysteresis ` +
        `\\(${esc(fmtPct(this.cfg.recoveryHysteresisPct))}%\\), otherwise alerts can never re\\-arm\\.`
      );
    }
    return null;
  }
}

const HELP_TEXT = [
  '🤖 *ATH Drawdown Bot — Commands*',
  '',
  '👀 *Watchlist*',
  '   📈 /watch `<mint>` `[pct]` — watch a token \\(verified on Jupiter first\\)',
  '   🗑️ /unwatch `<mint>` — stop watching',
  '   📋 /list — list watched tokens',
  '   🎯 /threshold `<mint|all>` `<pct>` — set drawdown threshold',
  '   📊 /status `<mint>` — current price, rolling ATH and drawdown',
  '   🔍 /check `<mint>` — full token card \\(market cap, holders, pools…\\)',
  '   ♻️ /resetath `<mint>` — reset the stored ATH and re\\-arm',
  '',
  '🔎 *GMGN scanner*',
  '   ⚡ /scan — run a drawdown scan cycle now',
  '   📡 /gmgnstatus — show the last scan summary',
  '',
  '🔔 *Subscription*',
  '   ✅ /start — subscribe this chat to alerts',
  '   🔕 /stop — unsubscribe this chat',
  '',
  '🧪 *Misc*',
  '   🖼️ /testalert — preview an example alert \\(rendered for SOL\\)',
  '   ❓ /help — this message',
].join('\n');
