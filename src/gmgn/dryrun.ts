/**
 * Safe GMGN dry-run: runs ONE real scan cycle against the configured GMGN API and
 * prints a summary + a few example candidates. It NEVER sends Telegram alerts (the
 * notifier is a no-op) and NEVER prints secrets (API key / bot token are not logged).
 *
 * Usage: `bun run gmgn:dryrun`
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig } from '../alerts/config';
import { GmgnClient } from './client';
import { GmgnScreenedStore } from './store';
import { GmgnScanner } from './scanner';
import type { ScreenedCandidate } from './scanner';

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
  const cfg = buildConfig(process.env).gmgn;

  if (!cfg.apiKey) {
    console.error('GMGN_API_KEY is not set. Add it to your environment/.env to run the dry-run.');
    process.exit(1);
  }

  console.log('[dryrun] GMGN dry-run — no Telegram alerts will be sent.');
  console.log(
    `[dryrun] config: baseUrl=${cfg.baseUrl} scanLimit=${cfg.scanLimit} ` +
      `concurrency=${cfg.scanConcurrency} feeMin=${cfg.totalFeeMinSol} ` +
      `mcapMin=${cfg.marketCapMinUsd} drawdownMin=${cfg.drawdownMinPct}% ` +
      `age=[${cfg.minTokenAgeHours}h, ${cfg.maxTokenAgeDays}d]`,
  );

  const client = new GmgnClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    attempts: cfg.attempts,
    backoffMs: cfg.backoffMs,
    timeoutMs: cfg.timeoutMs,
    minIntervalMs: cfg.requestIntervalMs,
    rateLimitCooldownMs: cfg.rateLimitCooldownMs,
  });

  // Ephemeral dedupe store (no-op writer, throwaway path): never touches real data.
  const store = new GmgnScreenedStore(join(tmpdir(), `gmgn-dryrun-${Date.now()}.json`), {
    writer: async () => {},
  });
  await store.init();

  // No-op notifier: guarantees the dry-run cannot deliver to Telegram. No watch store,
  // no Meteora linker — this is strictly a GMGN screening probe.
  const scanner = new GmgnScanner(cfg, { client, store, notify: async () => false });

  const passed: ScreenedCandidate[] | null = await scanner.runCycle();
  const status = scanner.status();
  const summary = status.lastSummary;

  if (!summary) {
    console.error('[dryrun] scan did not complete.');
    if (status.lastError) console.error(`[dryrun] error: ${status.lastError.message}`);
    process.exit(1);
  }

  const candidates = passed ?? [];
  const securityFails = candidates.filter((c) => c.verdict === 'FAIL').length;

  console.log('\n[dryrun] === summary ===');
  console.log(`  trending (rank rows): ${summary.trending}`);
  console.log(`  quick-pass:           ${summary.quickPass}`);
  console.log(`  base-pass:            ${summary.basePass}`);
  console.log(`  security FAILs:       ${securityFails}`);
  console.log(`  deliverable:          ${summary.deliverable}`);
  console.log(`  would-alert (fresh):  ${summary.fresh}  (no alert was sent)`);
  if (summary.baseDropSummary !== '') {
    console.log(`  base-drop reasons:    ${summary.baseDropSummary}`);
  }
  if (status.lastError) console.log(`  last error:           ${status.lastError.message}`);

  if (candidates.length > 0) {
    console.log('\n[dryrun] === examples (up to 5 base-pass) ===');
    for (const c of candidates.slice(0, 5)) {
      console.log(
        `  ${c.verdict.padEnd(4)} ${(c.symbol ?? '?').padEnd(10)} ${shortMint(c.mint)}  ` +
          `down ${c.drawdownPct.toFixed(1)}%  mcap ${fmtUsd(c.marketCap)}  ` +
          `fees ${c.totalFeeSol.toFixed(1)} SOL` +
          (c.warnings.length > 0 ? `  ⚠ ${c.warnings.slice(0, 2).join('; ')}` : '') +
          (c.hardFails.length > 0 ? `  ⛔ ${c.hardFails.slice(0, 2).join('; ')}` : ''),
      );
    }
  } else {
    console.log('\n[dryrun] no base-pass candidates this cycle.');
  }
}

main().catch((err) => {
  console.error('[dryrun] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
