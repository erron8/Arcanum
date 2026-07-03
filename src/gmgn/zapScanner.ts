import type { ZapConfig } from '../alerts/config';
import { GmgnClient, toNum } from './client';
import { GmgnScreenedStore } from './store';
import {
  athFromKline,
  buildGmgnDisplay,
  infoPrice,
  screenSecurity,
  summarizeReasons,
  type GmgnNotifier,
  type SecurityResult,
} from './scanner';
import { computeSupertrend } from './indicators';
import { formatRichMessages } from '../alerts/richFormat';
import type { RichTokenView } from '../alerts/richFormat';
import type { MeteoraLinker } from '../meteora/client';
import type { GmgnKlineCandle, GmgnRankItem, GmgnTokenInfo } from './types';

const CHAIN = 'sol';
const HOUR_MS = 3_600_000;
/** Bound on the ATH-fallback hourly kline lookback (days) so the request stays bounded. */
const ATH_FALLBACK_LOOKBACK_DAYS = 14;

/** Final, deliverable "zap in" candidate for one token. */
export interface ZapCandidate {
  mint: string;
  symbol?: string;
  name?: string;
  price: number;
  marketCap: number;
  ageHours: number;
  athPrice: number;
  vol5mUsd: number;
  /** The Supertrend line value at the latest 15m bar (bullish → price is above it). */
  supertrendValue: number;
  /** Human-readable entry signals shown on the alert card. */
  signals: string[];
  view: RichTokenView;
}

// --- candidate source quick filter -----------------------------------------

/**
 * Cheap client-side filter over a rank row, applied before fetching token detail.
 * Mirrors the drawdown scanner's quick filter but WITHOUT the smart-money floor:
 * a fresh-ATH breakout does not require pre-existing smart-degen holders. Only
 * excludes when a field is present and clearly disqualifying.
 */
export function quickFilterZapRank(
  item: GmgnRankItem,
  cfg: Pick<ZapConfig, 'marketCapMinUsd'>,
): boolean {
  if (!item.address) return false;
  if (typeof item.market_cap === 'number' && item.market_cap < cfg.marketCapMinUsd) return false;
  if (item.is_wash_trading === true) return false;
  if (typeof item.bundler_rate === 'number' && item.bundler_rate >= 0.3) return false;
  return true;
}

// --- volume helper ---------------------------------------------------------

// --- security (zap-specific severity) --------------------------------------

/**
 * Security reasons that `screenSecurity` treats as hard blocks but the Zap path
 * downgrades to warnings. A *fresh-ATH token under 2 days old* routinely has high
 * holder concentration and many snipers — blocking on those would suppress every zap
 * alert. The genuinely dangerous checks (honeypot / unrenounced mint+freeze / wash
 * trading / rug ratio / creator-hold / bundler dominance) stay hard blocks.
 */
const ZAP_SOFT_SECURITY_PREFIXES = ['top_10_holder_rate', 'sniper_count'];

/**
 * Split the security screen into what still blocks a zap alert vs. what is merely a
 * warning shown on the card. Pure so it is unit-testable.
 */
export function partitionZapSecurity(sec: SecurityResult): {
  blocking: string[];
  warnings: string[];
} {
  const blocking: string[] = [];
  const softened: string[] = [];
  for (const f of sec.hardFails) {
    if (ZAP_SOFT_SECURITY_PREFIXES.some((p) => f.startsWith(p))) softened.push(f);
    else blocking.push(f);
  }
  return { blocking, warnings: [...sec.warnings, ...softened] };
}

/** Largest single-candle USD volume across the given candles (0 if none/invalid). */
export function max5mVolume(candles: GmgnKlineCandle[]): number {
  let max = 0;
  for (const c of candles) {
    const v = toNum(c.volume);
    if (v !== undefined && v > max) max = v;
  }
  return max;
}

// --- base filter (info-derivable gates) ------------------------------------

export interface ZapBaseResult {
  pass: boolean;
  reasons: string[];
  price: number;
  marketCap: number;
  ageHours: number;
  athPrice: number;
  drawdownPct: number;
}

/**
 * Apply the info-derivable Zap gates: market cap floor and "at a new ATH" (current price
 * within `athTolerancePct` of the ATH). Fails closed on a missing/zero price or an unknown
 * ATH — an entry reminder must not fire on bad data. Token age is computed for display but
 * is NOT a gate. Volume, Supertrend, and the security safety gate are checked by the scanner.
 */
export function zapBaseFilter(
  info: GmgnTokenInfo,
  cfg: Pick<ZapConfig, 'marketCapMinUsd' | 'athTolerancePct'>,
  opts: { nowMs?: number; klineAth?: number; fallbackMarketCap?: number } = {},
): ZapBaseResult {
  const nowMs = opts.nowMs ?? Date.now();
  const reasons: string[] = [];

  // Current price — fail closed if missing/non-positive.
  const priceVal = infoPrice(info.price);
  const priceKnown = priceVal !== undefined && priceVal > 0;
  const price = priceKnown ? priceVal : 0;
  if (!priceKnown) reasons.push('current price unavailable');

  // Market cap: explicit → price × circulating supply → rank-row fallback.
  const explicitMcap = toNum(info.market_cap);
  const circulating = toNum(info.circulating_supply);
  const marketCap =
    explicitMcap !== undefined && explicitMcap > 0
      ? explicitMcap
      : circulating !== undefined && price > 0
        ? price * circulating
        : (opts.fallbackMarketCap ?? 0);
  if (marketCap < cfg.marketCapMinUsd) {
    reasons.push(`market_cap ${Math.round(marketCap)} < ${cfg.marketCapMinUsd} USD`);
  }

  // Token age is informational only — there is no age gate. Compute it (open_timestamp,
  // else creation_timestamp; Unix seconds) for the alert card when it is available.
  const openedAt = toNum(info.open_timestamp) ?? toNum(info.creation_timestamp);
  const ageHours =
    openedAt !== undefined && openedAt > 0 ? (nowMs - openedAt * 1000) / HOUR_MS : 0;

  // ATH: prefer info.ath_price, fall back to the kline-derived high. If the current
  // price prints a new high above the stored ATH, treat the current price as the ATH.
  let athPrice = infoPrice(info.ath_price) ?? 0;
  if (!(athPrice > 0) && opts.klineAth !== undefined) athPrice = opts.klineAth;
  if (priceKnown && price > athPrice) athPrice = price;

  // "At a new ATH": drawdown from ATH must be within tolerance (near/at the peak).
  let drawdownPct = 0;
  if (!priceKnown) {
    // already failed
  } else if (athPrice > 0) {
    drawdownPct = ((athPrice - price) / athPrice) * 100;
    if (drawdownPct > cfg.athTolerancePct) {
      reasons.push(`drawdown ${drawdownPct.toFixed(1)}% > ${cfg.athTolerancePct}% (not at ATH)`);
    }
  } else {
    reasons.push('ATH price unavailable');
  }

  return {
    pass: reasons.length === 0,
    reasons,
    price,
    marketCap,
    ageHours,
    athPrice,
    drawdownPct,
  };
}

// --- signal formatting -----------------------------------------------------

function compactUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function ageLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '?';
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// --- scanner orchestration -------------------------------------------------

/** Per-cycle counts, surfaced for the /zap reply and /zapstatus. */
export interface ZapCycleSummary {
  trending: number;
  quickPass: number;
  /** Tokens that cleared every Zap gate (mcap, ATH, volume, Supertrend, safety). */
  qualified: number;
  fresh: number;
  delivered: boolean;
  /** Summarized drop reasons across the cycle, e.g. "supertrend×5, volume×3" (or ''). */
  dropSummary: string;
}

/** Observable scanner state for the /zapstatus command. */
export interface ZapScanStatus {
  scanning: boolean;
  lastSummary: ZapCycleSummary | null;
  lastSummaryAt: number | null;
  lastError: { message: string; at: number } | null;
  lastDelivered: { mint: string; symbol?: string; at: number } | null;
}

export interface ZapScannerDeps {
  client: GmgnClient;
  store: GmgnScreenedStore;
  notify: GmgnNotifier;
  meteora?: MeteoraLinker;
  now?: () => number;
}

function gmgnLink(mint: string, info: GmgnTokenInfo | null): string {
  return info?.link?.gmgn ?? `https://gmgn.ai/sol/token/${mint}`;
}

/** Bounded worker pool: run `fn` over `items` with at most `limit` concurrent calls. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];
  const n = Math.max(1, Math.min(limit, queue.length || 1));
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      results.push(await fn(item));
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Zap In reminder scanner. Pulls trending tokens and keeps only those at a *fresh*
 * ATH with bullish momentum:
 *   1. market cap ≥ threshold,
 *   2. current price at a new ATH (drawdown within tolerance) and that ATH was touched
 *      in the recent 5m window ("just made new ATH"),
 *   3. a recent 5-minute candle with volume ≥ the floor,
 *   4. a bullish 15m Supertrend,
 *   5. no blocking security issue (honeypot / unrenounced / wash trading).
 *
 * Qualifying tokens are pushed as separate `Zap In Reminder` alerts. Like the GMGN
 * drawdown scanner it never touches the manual `/watch` AlertStore, dedupes via its
 * own screened store, and is self-contained (one token's failure never aborts a cycle).
 */
export class ZapScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private stopped = false;
  private currentCycle: Promise<ZapCandidate[] | null> | null = null;
  private dropReasons: string[] = [];
  private lastSummary: ZapCycleSummary | null = null;
  private lastSummaryAt: number | null = null;
  private lastError: { message: string; at: number } | null = null;
  private lastDelivered: { mint: string; symbol?: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly cfg: ZapConfig,
    private readonly deps: ZapScannerDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.cfg.scanIntervalMs);
  }

  /** Stop ticking and await any in-flight cycle so shutdown doesn't race a scan. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentCycle) {
      try {
        await this.currentCycle;
      } catch {
        /* already logged in runCycle */
      }
    }
  }

  isScanning(): boolean {
    return this.scanning;
  }

  /** Guarded cycle: skips (and logs) if a previous cycle is still running. */
  async runCycle(): Promise<ZapCandidate[] | null> {
    if (this.stopped) return null;
    if (this.scanning) {
      console.warn('[zap] previous scan still running — skipping this tick.');
      return null;
    }
    this.scanning = true;
    const cycle = (async (): Promise<ZapCandidate[] | null> => {
      try {
        return await this.scanOnce();
      } catch (err) {
        console.error('[zap] scan cycle error:', err);
        this.lastError = {
          message: err instanceof Error ? err.message : String(err),
          at: this.now(),
        };
        return null;
      } finally {
        this.scanning = false;
      }
    })();
    this.currentCycle = cycle;
    try {
      return await cycle;
    } finally {
      if (this.currentCycle === cycle) this.currentCycle = null;
    }
  }

  /** Run one cycle on demand (e.g. `/zap`) and return its summary, or null if busy. */
  async scanNow(): Promise<ZapCycleSummary | null> {
    const result = await this.runCycle();
    return result === null ? null : this.lastSummary;
  }

  status(): ZapScanStatus {
    return {
      scanning: this.scanning,
      lastSummary: this.lastSummary,
      lastSummaryAt: this.lastSummaryAt,
      lastError: this.lastError,
      lastDelivered: this.lastDelivered,
    };
  }

  /** One full scan cycle. Returns every fully-qualifying zap candidate. */
  async scanOnce(): Promise<ZapCandidate[]> {
    this.dropReasons = [];
    const rank = await this.deps.client.getRank({
      chain: CHAIN,
      interval: '5m',
      order_by: 'volume',
      direction: 'desc',
      limit: this.cfg.scanLimit,
      filters: ['renounced', 'frozen', 'not_wash_trading'],
    });

    const candidates = rank.filter((item) => quickFilterZapRank(item, this.cfg));
    const screened = await runPool(candidates, this.cfg.scanConcurrency, (item) =>
      this.processCandidate(item),
    );
    const qualified = screened.filter((c): c is ZapCandidate => c !== null);

    const fresh = qualified.filter(
      (c) => !this.deps.store.wasRecentlyAlerted(c.mint, this.cfg.dedupeMs),
    );

    let delivered = false;
    if (fresh.length > 0 && !this.stopped) {
      await this.attachMeteoraLinks(fresh);
      const messages = formatRichMessages(fresh.map((c) => c.view));
      try {
        delivered = await this.deps.notify(messages);
      } catch (err) {
        console.error('[zap] notify failed:', err);
      }
      if (delivered) {
        for (const c of fresh) {
          try {
            await this.deps.store.record(c.mint, c.symbol, this.cfg.dedupeMs);
          } catch (err) {
            console.error(
              `[zap] failed to persist dedupe record for ${c.mint} — ` +
                `it may re-alert after a restart:`,
              err,
            );
          }
        }
        const last = fresh[fresh.length - 1]!;
        this.lastDelivered = { mint: last.mint, symbol: last.symbol, at: this.now() };
        console.log(`[zap] alerted ${fresh.length} candidate(s).`);
      }
    }

    const dropSummary = this.dropReasons.length > 0 ? summarizeReasons(this.dropReasons) : '';
    console.log(
      `[zap] cycle: ${rank.length} trending → ${candidates.length} quick-pass → ` +
        `${qualified.length} qualified → ${fresh.length} new`,
    );
    if (dropSummary !== '') console.log(`[zap] drops: ${dropSummary}`);

    this.lastSummary = {
      trending: rank.length,
      quickPass: candidates.length,
      qualified: qualified.length,
      fresh: fresh.length,
      delivered,
      dropSummary,
    };
    this.lastSummaryAt = this.now();
    return qualified;
  }

  /** Best-effort: attach Meteora DLMM pool links to each candidate's view before delivery. */
  private async attachMeteoraLinks(candidates: ZapCandidate[]): Promise<void> {
    const linker = this.deps.meteora;
    if (!linker) return;
    await Promise.all(
      candidates.map(async (c) => {
        try {
          c.view.meteoraPools = await linker(c.mint);
        } catch (err) {
          console.error(
            `[zap] meteora links ${c.mint} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
  }

  /**
   * Screen one token against every Zap gate, in ascending cost order so a failing
   * cheap gate short-circuits the expensive calls. Returns null (and records a drop
   * reason) at the first failed gate; a per-token error never aborts the cycle.
   */
  private async processCandidate(item: GmgnRankItem): Promise<ZapCandidate | null> {
    const mint = item.address!;
    try {
      const info = await this.deps.client.getTokenInfo(CHAIN, mint);
      if (!info) return null;

      const nowMs = this.now();
      // ATH fallback from the full-lifetime hourly kline when ath_price is absent.
      let klineAth: number | undefined;
      if (!((infoPrice(info.ath_price) ?? 0) > 0)) {
        klineAth = athFromKline(await this.fetchAthKline(mint, info, nowMs));
      }
      const base = zapBaseFilter(info, this.cfg, {
        nowMs,
        klineAth,
        fallbackMarketCap: toNum(item.market_cap),
      });
      if (!base.pass) {
        for (const r of base.reasons) this.dropReasons.push(r);
        return null;
      }

      // Volume + ATH-freshness from the recent 5m window.
      const recent5m = await this.fetchRecent5mKline(mint, nowMs);
      const vol5mUsd = max5mVolume(recent5m);
      if (vol5mUsd < this.cfg.volumeMin5mUsd) {
        this.dropReasons.push(`volume ${Math.round(vol5mUsd)} < ${this.cfg.volumeMin5mUsd} /5m`);
        return null;
      }
      // "Just made new ATH": the ATH must have been touched within the recent 5m window.
      const recentHigh = athFromKline(recent5m);
      const freshFloor = base.athPrice * (1 - this.cfg.athTolerancePct / 100);
      if (!(recentHigh >= freshFloor)) {
        this.dropReasons.push('ath not fresh (no recent new-high candle)');
        return null;
      }

      // Bullish 15m Supertrend.
      const kline15m = await this.fetchSupertrendKline(mint, nowMs);
      const st = computeSupertrend(kline15m, this.cfg.supertrendPeriod, this.cfg.supertrendMultiplier);
      if (!st || !st.bullish) {
        this.dropReasons.push(st ? 'supertrend bearish' : 'supertrend insufficient data');
        return null;
      }

      // Safety gate: block honeypot / unrenounced / wash trading before an entry alert.
      // Snipers / holder concentration are downgraded to warnings for the zap path
      // (see partitionZapSecurity) since young fresh-ATH tokens almost always trip them.
      const security = await this.deps.client.getTokenSecurity(CHAIN, mint);
      const zapSec = partitionZapSecurity(screenSecurity(security));
      if (zapSec.blocking.length > 0) {
        this.dropReasons.push(`unsafe (${zapSec.blocking[0]})`);
        return null;
      }

      // Display enrichment (holders/traders) — best-effort, for the alert card only.
      const [holders, traders] = await Promise.all([
        this.deps.client.getTopHolders(CHAIN, mint, 100).catch(() => []),
        this.deps.client.getTopTraders(CHAIN, mint, 100).catch(() => []),
      ]);

      const display = buildGmgnDisplay({
        info,
        security,
        holders,
        traders,
        recentKline: recent5m,
        totalVolumeUsd: toNum(item.volume),
        nowMs,
        base: {
          price: base.price,
          marketCap: base.marketCap,
          ageHours: base.ageHours,
          athPrice: base.athPrice,
          // drawdownPct intentionally omitted: at-ATH tokens should not show a ⬇️ tag.
        },
      });

      const signals = [
        `Fresh ATH · mcap ${compactUsd(base.marketCap)}`,
        `5m volume ${compactUsd(vol5mUsd)} ≥ ${compactUsd(this.cfg.volumeMin5mUsd)}`,
        `15m Supertrend bullish (${this.cfg.supertrendPeriod}/${this.cfg.supertrendMultiplier})`,
      ];
      if (base.ageHours > 0) signals.push(`Age ${ageLabel(base.ageHours)}`);
      if (zapSec.warnings.length > 0) signals.push(`Note: ${zapSec.warnings[0]}`);

      const view: RichTokenView = {
        ...display,
        kind: 'zap',
        mint,
        symbol: info.symbol ?? item.symbol,
        name: info.name ?? item.name,
        chain: 'Solana',
        signals,
        warnings: zapSec.warnings.length > 0 ? zapSec.warnings : undefined,
      };

      return {
        mint,
        symbol: info.symbol ?? item.symbol,
        name: info.name ?? item.name,
        price: base.price,
        marketCap: base.marketCap,
        ageHours: base.ageHours,
        athPrice: base.athPrice,
        vol5mUsd,
        supertrendValue: st.value,
        signals,
        view,
      };
    } catch (err) {
      console.error(`[zap] screening ${mint} failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Recent 5m candles (last ~30 minutes) for volume + ATH-freshness checks. */
  private fetchRecent5mKline(mint: string, nowMs: number): Promise<GmgnKlineCandle[]> {
    const toSec = Math.floor(nowMs / 1000);
    const fromSec = toSec - 30 * 60; // last 30 minutes → ~6 candles
    return this.deps.client.getKline(CHAIN, mint, '5m', fromSec, toSec);
  }

  /** 15m candles for the Supertrend, with enough history for a stable ATR. */
  private fetchSupertrendKline(mint: string, nowMs: number): Promise<GmgnKlineCandle[]> {
    const toSec = Math.floor(nowMs / 1000);
    const bars = Math.max(this.cfg.supertrendPeriod * 4, 40);
    const fromSec = toSec - bars * 15 * 60;
    return this.deps.client.getKline(CHAIN, mint, '15m', fromSec, toSec);
  }

  /**
   * Full-lifetime hourly kline for the ATH fallback: from the token's launch to now,
   * clamped to at most `ATH_FALLBACK_LOOKBACK_DAYS` so the range is always bounded.
   */
  private fetchAthKline(
    mint: string,
    info: GmgnTokenInfo,
    nowMs: number,
  ): Promise<GmgnKlineCandle[]> {
    const toSec = Math.floor(nowMs / 1000);
    const earliest = toSec - ATH_FALLBACK_LOOKBACK_DAYS * 24 * 3600;
    const launch = toNum(info.open_timestamp) ?? toNum(info.creation_timestamp);
    const fromSec = launch !== undefined && launch > earliest ? Math.floor(launch) : earliest;
    return this.deps.client.getKline(CHAIN, mint, '1h', fromSec, toSec);
  }
}
