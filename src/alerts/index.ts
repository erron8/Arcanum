import { buildConfig, validateEnv } from './config';
import { AlertStore } from './store';
import { AthMonitor } from './athMonitor';
import { TelegramTransport } from './telegramBot';
import { GmgnClient } from '../gmgn/client';
import { GmgnScreenedStore } from '../gmgn/store';
import { GmgnScanner } from '../gmgn/scanner';
import { makeGmgnEnricher } from '../gmgn/enrich';
import { MeteoraClient } from '../meteora/client';
import type { MeteoraLinker } from '../meteora/client';

/** Best-effort .env loading: use dotenv if installed, otherwise rely on process.env. */
async function loadEnv(): Promise<void> {
  try {
    // Non-literal specifier so the optional dep doesn't become a hard type/build dependency.
    const spec = 'dotenv';
    const dotenv = (await import(spec)) as { config?: () => void };
    dotenv.config?.();
  } catch {
    // dotenv not installed — Bun also auto-loads .env, and plain process.env works.
  }
}

async function main(): Promise<void> {
  await loadEnv();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.trim() === '') {
    console.error('FATAL: TELEGRAM_BOT_TOKEN is not set. Set it in the environment or .env.');
    process.exit(1);
  }

  // Fail fast on out-of-domain configuration before doing any work.
  const configErrors = validateEnv(process.env);
  if (configErrors.length > 0) {
    console.error('FATAL: invalid configuration:');
    for (const e of configErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // Build config from the environment *after* loadEnv() so .env values take effect.
  const config = buildConfig(process.env);

  const store = new AlertStore(config.storePath, { flushDelayMs: config.flushDelayMs });
  await store.init();

  const monitor = new AthMonitor(store, config);

  const bot = new TelegramTransport(token, store, monitor, config);
  await bot.init();

  // Wire monitor → telegram (settable sink resolves the circular dependency).
  monitor.setSink(bot.buildSink());

  // GMGN client — a valid GMGN_API_KEY is required at startup, so this is always built.
  // It powers both the drawdown scanner and rich-layout enrichment for /watch + /check.
  const gmgnClient = new GmgnClient({
    baseUrl: config.gmgn.baseUrl,
    apiKey: config.gmgn.apiKey,
    attempts: config.gmgn.attempts,
    backoffMs: config.gmgn.backoffMs,
    timeoutMs: config.gmgn.timeoutMs,
  });
  bot.setGmgnEnricher(makeGmgnEnricher(gmgnClient));

  // Meteora DLMM pool links (public API, no key) — added to every alert/card.
  let meteoraLinker: MeteoraLinker | undefined;
  if (config.meteora.enabled) {
    const meteora = new MeteoraClient({
      baseUrl: config.meteora.baseUrl,
      maxPools: config.meteora.maxPools,
      attempts: config.meteora.attempts,
      backoffMs: config.meteora.backoffMs,
      timeoutMs: config.meteora.timeoutMs,
    });
    meteoraLinker = (mint) => meteora.getPoolsByMint(mint);
    bot.setMeteoraLinker(meteoraLinker);
  }

  // GMGN drawdown scanner — a core, always-on feature.
  const screenedStore = new GmgnScreenedStore(config.gmgn.screenedPath);
  await screenedStore.init();
  const gmgnScanner = new GmgnScanner(config.gmgn, {
    client: gmgnClient,
    store: screenedStore,
    notify: (messages) => bot.notify(messages),
    watchStore: config.gmgn.autoWatch ? store : undefined,
    meteora: meteoraLinker,
  });
  bot.setGmgnScan(() => gmgnScanner.scanNow());
  bot.setGmgnStatus(() => gmgnScanner.status());

  let shuttingDown = false;
  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[index] ${signal} received — shutting down…`);
    monitor.stop();
    // Await the scanner so an in-flight cycle finishes (and won't notify) before
    // we stop Telegram below.
    try {
      await gmgnScanner?.stop();
    } catch (err) {
      console.error('[index] error stopping GMGN scanner:', err);
    }
    try {
      await bot.stop();
    } catch (err) {
      console.error('[index] error stopping bot:', err);
    }
    try {
      await store.flushNow();
    } catch (err) {
      console.error('[index] error flushing store:', err);
    }
    console.log('[index] bye.');
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Fail hard if Telegram polling dies after starting (e.g. another instance running).
  await bot.start((err) => {
    console.error('[index] FATAL: Telegram polling failed:', err);
    void shutdown('TELEGRAM-POLL', 1);
  });
  monitor.start();

  // Start the GMGN scanner only after Telegram is live so its alerts have a delivery path.
  gmgnScanner.start();
  console.log(
    `[index] GMGN scanner running · scanInterval=${config.gmgn.scanIntervalMs}ms · ` +
      `feeMin=${config.gmgn.totalFeeMinSol} SOL · mcapMin=$${config.gmgn.marketCapMinUsd} · ` +
      `drawdownMin=${config.gmgn.drawdownMinPct}% · autoWatch=${config.gmgn.autoWatch}`,
  );

  // The scanner needs at least one subscriber to deliver to. Warn loudly if there are
  // none yet — automatic alerts will be found but have nowhere to go until someone
  // sends /start (or TELEGRAM_CHAT_ID is set).
  if (bot.subscriberIds().length === 0) {
    console.warn(
      '[index] No subscribers yet — automatic scanner alerts have nowhere to send. ' +
        'Send /start to the bot (or set TELEGRAM_CHAT_ID) to receive them.',
    );
  }

  console.log(
    `[index] running · poll=${config.pollIntervalMs}ms · interval=${config.interval} · ` +
      `quote=${config.quote} · defaultThreshold=${config.defaultThresholdPct}%`,
  );
}

main().catch((err) => {
  console.error('[index] fatal:', err);
  process.exit(1);
});
