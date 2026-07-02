/**
 * Safe Zap In dry-run: runs ONE real Zap scan cycle against the configured GMGN API
 * and prints a summary + any qualifying candidates. It NEVER sends Telegram alerts (the
 * notifier is a no-op) and NEVER prints secrets (API key / bot token are not logged).
 *
 * Usage: `bun run zap:dryrun`
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GMGN_KEY_PLACEHOLDERS, buildConfig } from '../alerts/config';
import { GmgnClient } from './client';
import { GmgnScreenedStore } from './store';
import { ZapScanner } from './zapScanner';
import type { ZapCandidate } from './zapScanner';

/** Best-effort .env load (Bun also auto-loads .env); dotenv optional. */
async function loadEnv(): Promise<void> {
  try {
    const spec = 'dotenv';
    const dotenv = (await import(spec)) as { config?: () => void };
    dotenv.config?.();
  } catch {
    /* not installed — rely on process.env / Bun's .env */
  }
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 6)}…${mint.slice(-4)}` : mint;
}

async function main(): Promise<void> {
  await loadEnv();
  const full = buildConfig(process.env);
  const cfg = full.zap;
  const gmgn = full.gmgn;

  const hasRealKey = gmgn.apiKey !== '' && !GMGN_KEY_PLACEHOLDERS.has(gmgn.apiKey);
  if (!hasRealKey) {
    console.error('GMGN_API_KEY is not set. Add it to your environment/.env to run the dry-run.');
    process.exit(1);
  }

  console.log('[zap-dryrun] Zap In dry-run — no Telegram alerts will be sent.');
  console.log(
    `[zap-dryrun] config: scanLimit=${cfg.scanLimit} concurrency=${cfg.scanConcurrency} ` +
      `mcapMin=${cfg.marketCapMinUsd} athTol=${cfg.athTolerancePct}% ` +
      `vol5mMin=${cfg.volumeMin5mUsd} supertrend=${cfg.supertrendPeriod}/${cfg.supertrendMultiplier} ` +
      `maxAge=${cfg.maxTokenAgeHours}h`,
  );

  const client = new GmgnClient({
    baseUrl: gmgn.baseUrl,
    apiKey: gmgn.apiKey,
    attempts: gmgn.attempts,
    backoffMs: gmgn.backoffMs,
    timeoutMs: gmgn.timeoutMs,
    minIntervalMs: gmgn.requestIntervalMs,
    rateLimitCooldownMs: gmgn.rateLimitCooldownMs,
  });

  // Ephemeral dedupe store (no-op writer, throwaway path): never touches real data.
  const store = new GmgnScreenedStore(join(tmpdir(), `zap-dryrun-${Date.now()}.json`), {
    writer: async () => {},
  });
  await store.init();

  // No-op notifier: guarantees the dry-run cannot deliver to Telegram.
  const scanner = new ZapScanner(cfg, { client, store, notify: async () => false });

  const qualified: ZapCandidate[] | null = await scanner.runCycle();
  const status = scanner.status();
  const summary = status.lastSummary;

  if (!summary) {
    console.error('[zap-dryrun] scan did not complete.');
    if (status.lastError) console.error(`[zap-dryrun] error: ${status.lastError.message}`);
    process.exit(1);
  }

  console.log('\n[zap-dryrun] === summary ===');
  console.log(`  trending (rank rows): ${summary.trending}`);
  console.log(`  quick-pass:           ${summary.quickPass}`);
  console.log(`  qualified:            ${summary.qualified}`);
  console.log(`  would-alert (fresh):  ${summary.fresh}  (no alert was sent)`);
  if (summary.dropSummary !== '') {
    console.log(`  drop reasons:         ${summary.dropSummary}`);
  }
  if (status.lastError) console.log(`  last error:           ${status.lastError.message}`);

  const candidates = qualified ?? [];
  if (candidates.length > 0) {
    console.log('\n[zap-dryrun] === qualifying candidates ===');
    for (const c of candidates.slice(0, 10)) {
      console.log(
        `  ${(c.symbol ?? '?').padEnd(10)} ${shortMint(c.mint)}  ` +
          `mcap ${fmtUsd(c.marketCap)}  vol/5m ${fmtUsd(c.vol5mUsd)}  ` +
          `age ${c.ageHours.toFixed(1)}h`,
      );
    }
  } else {
    console.log('\n[zap-dryrun] no qualifying candidates this cycle.');
  }
}

main().catch((err) => {
  console.error('[zap-dryrun] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
