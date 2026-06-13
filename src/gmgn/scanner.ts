import type { GmgnConfig } from '../alerts/config';
import type { AlertStore } from '../alerts/store';
import { GmgnClient, toNum } from './client';
import { GmgnScreenedStore } from './store';
import { formatRichMessages } from '../alerts/richFormat';
import type { RichTokenView } from '../alerts/richFormat';
import type { MeteoraLinker } from '../meteora/client';
import type {
  GmgnKlineCandle,
  GmgnRankItem,
  GmgnTokenInfo,
  GmgnTokenSecurity,
  GmgnWalletEntry,
} from './types';

const HOUR_MS = 3_600_000;
const CHAIN = 'sol';

export type ScreeningVerdict = 'PASS' | 'WARN' | 'FAIL';

/** Final, deliverable screening result for one token. */
export interface ScreenedCandidate {
  mint: string;
  symbol?: string;
  name?: string;
  price: number;
  marketCap: number;
  totalFeeSol: number;
  ageHours: number;
  athPrice: number;
  drawdownPct: number;
  verdict: ScreeningVerdict;
  hardFails: string[];
  warnings: string[];
  smartMoney: SmartMoneySummary;
  links: { gmgn?: string; jupiter?: string; birdeye?: string };
  /** Pre-built rich layout view used for the Telegram alert. */
  view: RichTokenView;
}

// --- candidate source quick filter ----------------------------------------

/**
 * Cheap client-side filter over a rank row, applied before fetching token detail.
 * Only excludes when a field is present and clearly disqualifying, so missing
 * fields never silently drop a candidate.
 */
export function quickFilterRank(
  item: GmgnRankItem,
  cfg: Pick<GmgnConfig, 'marketCapMinUsd'>,
): boolean {
  if (!item.address) return false;
  if (typeof item.market_cap === 'number' && item.market_cap < cfg.marketCapMinUsd) return false;
  if (item.is_wash_trading === true) return false;
  if (typeof item.bundler_rate === 'number' && item.bundler_rate >= 0.3) return false;
  if (typeof item.smart_degen_count === 'number' && item.smart_degen_count < 1) return false;
  return true;
}

// --- base filter -----------------------------------------------------------

export interface BaseFilterResult {
  pass: boolean;
  reasons: string[];
  totalFeeSol: number;
  marketCap: number;
  ageHours: number;
  price: number;
  athPrice: number;
  drawdownPct: number;
}

/**
 * Read a GMGN price-style field that may be a scalar (`"0.00041"`) or a nested
 * object (`{ price: "0.00041" }`). The live `token/info` payload returns `price`
 * (and sometimes `ath_price`) as the nested form; a plain `toNum` would read that
 * as undefined and silently zero the price — collapsing market cap to 0.
 */
export function infoPrice(field: unknown): number | undefined {
  if (field !== null && typeof field === 'object') {
    return toNum((field as { price?: unknown }).price);
  }
  return toNum(field);
}

/** Highest `high` across kline candles (ATH fallback when info.ath_price is missing). */
export function athFromKline(candles: GmgnKlineCandle[]): number {
  let max = 0;
  for (const c of candles) {
    const h = toNum(c.high);
    if (h !== undefined && h > max) max = h;
  }
  return max;
}

/**
 * Apply the base drawdown filter to a token-info payload. A token passes only if
 * total_fee, market cap, age and ATH drawdown all clear the configured thresholds.
 */
export function baseFilter(
  info: GmgnTokenInfo,
  cfg: Pick<
    GmgnConfig,
    | 'totalFeeMinSol'
    | 'marketCapMinUsd'
    | 'drawdownMinPct'
    | 'minTokenAgeHours'
    | 'maxTokenAgeDays'
  >,
  opts: { nowMs?: number; klineAth?: number; fallbackMarketCap?: number } = {},
): BaseFilterResult {
  const nowMs = opts.nowMs ?? Date.now();
  const reasons: string[] = [];

  const totalFeeSol = toNum(info.total_fee) ?? 0;
  if (totalFeeSol < cfg.totalFeeMinSol) {
    reasons.push(`total_fee ${totalFeeSol} < ${cfg.totalFeeMinSol} SOL`);
  }

  const price = infoPrice(info.price) ?? 0;
  // Market cap: explicit info.market_cap → price × circulating supply → rank-row
  // fallback (e.g. when info omits both). Failing all three it stays 0 and fails.
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

  // Token age: prefer open_timestamp, else creation_timestamp (both Unix seconds).
  const openedAt = toNum(info.open_timestamp) ?? toNum(info.creation_timestamp);
  let ageHours = 0;
  if (openedAt !== undefined && openedAt > 0) {
    ageHours = (nowMs - openedAt * 1000) / HOUR_MS;
  } else {
    reasons.push('token age unknown (no open/creation timestamp)');
  }
  const maxAgeHours = cfg.maxTokenAgeDays * 24;
  if (openedAt !== undefined && (ageHours < cfg.minTokenAgeHours || ageHours > maxAgeHours)) {
    reasons.push(
      `age ${ageHours.toFixed(1)}h outside [${cfg.minTokenAgeHours}h, ${maxAgeHours}h]`,
    );
  }

  // Drawdown from ATH: prefer info.ath_price, fall back to the kline-derived high.
  let athPrice = infoPrice(info.ath_price) ?? 0;
  if (!(athPrice > 0) && opts.klineAth !== undefined) athPrice = opts.klineAth;
  let drawdownPct = 0;
  if (athPrice > 0 && price >= 0) {
    drawdownPct = ((athPrice - price) / athPrice) * 100;
    if (drawdownPct < cfg.drawdownMinPct) {
      reasons.push(`drawdown ${drawdownPct.toFixed(1)}% < ${cfg.drawdownMinPct}%`);
    }
  } else {
    reasons.push('ATH price unavailable');
  }

  return {
    pass: reasons.length === 0,
    reasons,
    totalFeeSol,
    marketCap,
    ageHours,
    price,
    athPrice,
    drawdownPct,
  };
}

// --- security screening ----------------------------------------------------

export interface SecurityResult {
  hardFails: string[];
  warnings: string[];
}

/**
 * True only when a renounce field is CONFIRMED renounced (1 / true / "yes").
 * Anything else — explicit false (0/"no") or a missing/unknown value — is treated
 * as not renounced, so the caller fails closed rather than letting an absent field
 * silently pass a deep-drawdown safety check.
 */
function isConfirmedRenounced(v: unknown): boolean {
  if (v === 1 || v === true) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'yes' || s === 'true' || s === '1';
  }
  return false;
}

/**
 * Screen the security payload. Returns hard-fail reasons (block) and soft warnings
 * (annotate but allow), following the documented screening thresholds.
 */
export function screenSecurity(security: GmgnTokenSecurity | null): SecurityResult {
  const hardFails: string[] = [];
  const warnings: string[] = [];

  if (!security) {
    warnings.push('security data unavailable');
    return { hardFails, warnings };
  }

  if (!isConfirmedRenounced(security.renounced_mint)) {
    hardFails.push('mint authority not renounced/unknown');
  }
  if (!isConfirmedRenounced(security.renounced_freeze_account)) {
    hardFails.push('freeze authority not renounced/unknown');
  }
  if (security.is_wash_trading === true) hardFails.push('wash trading detected');
  if (security.creator_token_status === 'creator_hold') hardFails.push('creator still holding');

  const rug = toNum(security.rug_ratio);
  if (rug !== undefined) {
    if (rug > 0.3) hardFails.push(`rug_ratio ${rug.toFixed(2)} > 0.30`);
    else if (rug >= 0.1) warnings.push(`rug_ratio ${rug.toFixed(2)} (0.10–0.30)`);
  }

  const top10 = toNum(security.top_10_holder_rate);
  if (top10 !== undefined) {
    if (top10 > 0.5) hardFails.push(`top_10_holder_rate ${top10.toFixed(2)} > 0.50`);
    else if (top10 >= 0.2) warnings.push(`top_10_holder_rate ${top10.toFixed(2)} (0.20–0.50)`);
  }

  const snipers = toNum(security.sniper_count);
  if (snipers !== undefined) {
    if (snipers > 20) hardFails.push(`sniper_count ${snipers} > 20`);
    else if (snipers >= 5) warnings.push(`sniper_count ${snipers} (5–20)`);
  }

  const bundler = toNum(security.bundler_trader_amount_rate);
  if (bundler !== undefined) {
    if (bundler > 0.4) hardFails.push(`bundler_trader_amount_rate ${bundler.toFixed(2)} > 0.40`);
    else if (bundler >= 0.2) {
      warnings.push(`bundler_trader_amount_rate ${bundler.toFixed(2)} (0.20–0.40)`);
    }
  }

  return { hardFails, warnings };
}

// --- holders / smart money -------------------------------------------------

export interface SmartMoneySummary {
  smHolding: number;
  kolHolding: number;
  smExited: number;
  kolExited: number;
  smUnrealizedPositive: number;
  topSmBuyVolume: number;
}

const hasTag = (e: GmgnWalletEntry, tag: string): boolean =>
  Array.isArray(e.tags) && e.tags.includes(tag);

/**
 * Extract KOL / smart-money signals from holder + trader lists. Wallets are
 * deduped by address across both lists (a trader row supplements a holder row).
 */
export function extractSmartMoney(
  holders: GmgnWalletEntry[],
  traders: GmgnWalletEntry[],
): SmartMoneySummary {
  const byAddr = new Map<string, GmgnWalletEntry>();
  const order: string[] = [];
  for (const e of [...holders, ...traders]) {
    const key = e.address ?? `${order.length}`;
    if (!byAddr.has(key)) {
      byAddr.set(key, { ...e });
      order.push(key);
    } else {
      // Merge: keep the most informative (non-undefined) fields.
      byAddr.set(key, { ...byAddr.get(key)!, ...stripUndefined(e) });
    }
  }

  let smHolding = 0;
  let kolHolding = 0;
  let smExited = 0;
  let kolExited = 0;
  let smUnrealizedPositive = 0;
  let topSmBuyVolume = 0;

  for (const key of order) {
    const e = byAddr.get(key)!;
    const isSm = hasTag(e, 'smart_degen');
    const isKol = hasTag(e, 'kol');
    if (!isSm && !isKol) continue;

    const stillHolding = e.end_holding_at === null; // null = still holding per docs
    const exited =
      typeof e.sell_amount_percentage === 'number' && e.sell_amount_percentage > 0.8;

    if (isSm) {
      if (stillHolding) smHolding++;
      if (exited) smExited++;
      if (typeof e.unrealized_profit === 'number' && e.unrealized_profit > 0) {
        smUnrealizedPositive++;
      }
      if (typeof e.buy_volume_cur === 'number' && e.buy_volume_cur > topSmBuyVolume) {
        topSmBuyVolume = e.buy_volume_cur;
      }
    }
    if (isKol) {
      if (stillHolding) kolHolding++;
      if (exited) kolExited++;
    }
  }

  return { smHolding, kolHolding, smExited, kolExited, smUnrealizedPositive, topSmBuyVolume };
}

/**
 * Bucket base-filter reasons by their leading keyword and count each, e.g.
 * `market_cap×8, drawdown×3, total_fee×1`. Keeps the log line short regardless
 * of how many tokens dropped for the same reason.
 */
export function summarizeReasons(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) {
    const key = r.split(/\s+/, 1)[0] ?? r;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`)
    .join(', ');
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// --- rich view mapping -----------------------------------------------------

/** Title-case a launchpad tag for display (e.g. "pump" → "Pump"). */
function prettyPlatform(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function socialsFromInfo(info: GmgnTokenInfo | null): RichTokenView['socials'] {
  const lnk = info?.link;
  if (!lnk) return undefined;
  const twitter = lnk.twitter_username
    ? `https://x.com/${lnk.twitter_username.replace(/^@/, '')}`
    : undefined;
  const out = { website: lnk.website, twitter, telegram: lnk.telegram };
  return out.website || out.twitter || out.telegram ? out : undefined;
}

/** Volume (USD) summed across candles. */
function sumVolume(candles: GmgnKlineCandle[]): number {
  let s = 0;
  for (const c of candles) s += toNum(c.volume) ?? 0;
  return s;
}

/** Percent change across a candle window (first open → last close). */
function changePct(candles: GmgnKlineCandle[]): number | undefined {
  if (candles.length === 0) return undefined;
  const firstOpen = toNum(candles[0]!.open);
  const lastClose = toNum(candles[candles.length - 1]!.close);
  if (firstOpen === undefined || lastClose === undefined || !(firstOpen > 0)) return undefined;
  return ((lastClose - firstOpen) / firstOpen) * 100;
}

export interface GmgnDisplayInputs {
  info: GmgnTokenInfo | null;
  security?: GmgnTokenSecurity | null;
  holders?: GmgnWalletEntry[];
  traders?: GmgnWalletEntry[];
  recentKline?: GmgnKlineCandle[];
  /** Total volume from the rank row (token/info has no volume of its own). */
  rankVolume?: number;
  /** Pre-computed base values so we don't recompute what the scanner already has. */
  base?: {
    price?: number;
    marketCap?: number;
    ageHours?: number;
    athPrice?: number;
    drawdownPct?: number;
  };
}

/**
 * Map raw GMGN payloads into the display fields of a {@link RichTokenView}. Used by
 * the scanner (which then adds verdict/warnings) and by the /watch enricher (display
 * only). Every field is best-effort — missing data is simply omitted.
 */
export function buildGmgnDisplay(inp: GmgnDisplayInputs): Partial<RichTokenView> {
  const { info } = inp;
  const price = inp.base?.price ?? infoPrice(info?.price);
  const supply = toNum(info?.circulating_supply) ?? toNum(info?.total_supply);
  const fdvUsd =
    inp.base?.marketCap ??
    toNum(info?.market_cap) ??
    (price !== undefined && supply !== undefined ? price * supply : undefined);
  const athPrice = inp.base?.athPrice ?? infoPrice(info?.ath_price);
  const fdvAthUsd =
    athPrice !== undefined && supply !== undefined ? athPrice * supply : undefined;

  const recent = inp.recentKline ?? [];
  const top10Rate =
    toNum(info?.stat?.top_10_holder_rate) ?? toNum(inp.security?.top_10_holder_rate);
  // bundler_trader_amount_rate is a 0–1 fraction (same scale screenSecurity compares).
  const bundlerRate = toNum(inp.security?.bundler_trader_amount_rate);

  const topHolders = (inp.holders ?? [])
    .filter((h) => h.address && typeof h.amount_percentage === 'number')
    .slice(0, 5)
    .map((h) => ({ address: h.address!, pct: (h.amount_percentage as number) * 100 }));

  const sm =
    inp.holders || inp.traders
      ? extractSmartMoney(inp.holders ?? [], inp.traders ?? [])
      : undefined;

  return {
    symbol: info?.symbol,
    name: info?.name,
    platform: prettyPlatform(info?.launchpad_platform),
    priceUsd: price,
    fdvUsd,
    fdvAthUsd,
    ageHours: inp.base?.ageHours,
    liquidityUsd: toNum(info?.liquidity),
    volumeUsd: inp.rankVolume,
    vol1hUsd: recent.length > 0 ? sumVolume(recent) : undefined,
    change1hPct: changePct(recent),
    athUsd: athPrice,
    drawdownPct: inp.base?.drawdownPct,
    holderCount: toNum(info?.holder_count),
    topHolders: topHolders.length > 0 ? topHolders : undefined,
    top10Pct: top10Rate !== undefined ? top10Rate * 100 : undefined,
    bundledPct: bundlerRate !== undefined ? bundlerRate * 100 : undefined,
    smartMoney: sm
      ? {
          smHolding: sm.smHolding,
          kolHolding: sm.kolHolding,
          smExited: sm.smExited,
          smUnrealizedPositive: sm.smUnrealizedPositive,
        }
      : undefined,
    socials: socialsFromInfo(info),
  };
}

// --- volume authenticity ---------------------------------------------------

/**
 * Inspect 5m candles (and cross-reference security/info stats) for fake-volume
 * patterns. Returns warning strings; an empty array means nothing suspicious.
 */
export function analyzeVolume(
  candles: GmgnKlineCandle[],
  cross: { security?: GmgnTokenSecurity | null; info?: GmgnTokenInfo | null } = {},
): string[] {
  const warnings: string[] = [];

  const volumes = candles.map((c) => toNum(c.volume) ?? 0);
  const closes = candles.map((c) => toNum(c.close) ?? 0).filter((x) => x > 0);

  if (volumes.length >= 3) {
    const maxVol = Math.max(...volumes);
    const maxIdx = volumes.indexOf(maxVol);
    const others = volumes.filter((_, i) => i !== maxIdx);
    const otherAvg = others.reduce((a, b) => a + b, 0) / Math.max(1, others.length);
    // One huge candle then (near) dead volume afterwards.
    const after = volumes.slice(maxIdx + 1);
    const afterAvg = after.length > 0 ? after.reduce((a, b) => a + b, 0) / after.length : 0;
    if (maxVol > 0 && otherAvg > 0 && maxVol > otherAvg * 5 && afterAvg < otherAvg * 0.2) {
      warnings.push('single volume spike then dead — possible coordinated pump');
    }

    // Many near-identical volume candles (bot churn).
    const positive = volumes.filter((v) => v > 0);
    if (positive.length >= 4) {
      let similar = 0;
      for (let i = 1; i < positive.length; i++) {
        const a = positive[i]!;
        const b = positive[i - 1]!;
        if (b > 0 && Math.abs(a - b) / b < 0.02) similar++;
      }
      if (similar >= Math.ceil(positive.length / 2)) {
        warnings.push('many near-identical volume candles — bot pattern');
      }
    }
  }

  // Flat price with high/active volume → wash-trading signature.
  if (closes.length >= 3) {
    const maxC = Math.max(...closes);
    const minC = Math.min(...closes);
    const avgC = closes.reduce((a, b) => a + b, 0) / closes.length;
    const priceFlat = avgC > 0 && (maxC - minC) / avgC < 0.02;
    const totalVol = volumes.reduce((a, b) => a + b, 0);
    if (priceFlat && totalVol > 0) {
      warnings.push('price flat while volume active — possible wash trading');
    }
  }

  // Cross-reference security / info stat fields.
  const sec = cross.security;
  if (sec) {
    if (sec.is_wash_trading === true) warnings.push('is_wash_trading flag set');
    const bundler = toNum(sec.bundler_trader_amount_rate);
    if (bundler !== undefined && bundler > 0.3) {
      warnings.push(`bundler_trader_amount_rate ${bundler.toFixed(2)} > 0.30`);
    }
    const rat = toNum(sec.rat_trader_amount_rate);
    if (rat !== undefined && rat > 0.2) {
      warnings.push(`rat_trader_amount_rate ${rat.toFixed(2)} > 0.20`);
    }
  }
  const bot = toNum(cross.info?.stat?.bot_degen_rate);
  if (bot !== undefined && bot > 0.4) {
    warnings.push(`bot_degen_rate ${bot.toFixed(2)} > 0.40`);
  }

  return warnings;
}

// --- scanner orchestration -------------------------------------------------

/** Delivers a batch of messages; returns true if at least one subscriber got them. */
export type GmgnNotifier = (messages: string[]) => Promise<boolean>;

/** Per-cycle counts, surfaced for manual-trigger replies and logging. */
export interface CycleSummary {
  trending: number;
  quickPass: number;
  basePass: number;
  deliverable: number;
  fresh: number;
  delivered: boolean;
}

export interface ScannerDeps {
  client: GmgnClient;
  store: GmgnScreenedStore;
  notify: GmgnNotifier;
  /** Optional watch store for GMGN_AUTO_WATCH. */
  watchStore?: AlertStore;
  /** Optional Meteora DLMM linker; adds pool links to deliverable alerts. */
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
 * GMGN drawdown scanner. Pulls trending tokens, applies the base drawdown filter,
 * runs the security/holders/volume screening workflow, dedupes, and pushes screening
 * alerts through an injected notifier. Self-contained: failures on one token never
 * abort the cycle, and overlapping cycles are skipped.
 */
export class GmgnScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;
  private stopped = false;
  /** The in-flight cycle promise, so shutdown can await it instead of racing it. */
  private currentCycle: Promise<ScreenedCandidate[] | null> | null = null;
  /** Base-filter drop reasons for the current cycle (reset each scan, for debug logging). */
  private baseDropReasons: string[] = [];
  /** Counts from the most recent completed cycle (for the manual /scan reply). */
  private lastSummary: CycleSummary | null = null;
  private readonly now: () => number;

  constructor(
    private readonly cfg: GmgnConfig,
    private readonly deps: ScannerDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.cfg.scanIntervalMs);
  }

  /**
   * Stop ticking and await any in-flight cycle so shutdown doesn't race a scan that
   * is mid-screening (which could otherwise try to notify after Telegram is stopping).
   * Once stopped, the scanner does not start new cycles or deliver alerts.
   */
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
  async runCycle(): Promise<ScreenedCandidate[] | null> {
    if (this.stopped) return null;
    if (this.scanning) {
      console.warn('[gmgn] previous scan still running — skipping this tick.');
      return null;
    }
    this.scanning = true;
    const cycle = (async (): Promise<ScreenedCandidate[] | null> => {
      try {
        return await this.scanOnce();
      } catch (err) {
        console.error('[gmgn] scan cycle error:', err);
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

  /**
   * Run one cycle on demand (e.g. a manual `/scan` command) and return its summary.
   * Reuses {@link runCycle}'s overlap guard: returns null if a cycle is already
   * running or the scanner is stopped, rather than launching a concurrent scan.
   */
  async scanNow(): Promise<CycleSummary | null> {
    const result = await this.runCycle();
    return result === null ? null : this.lastSummary;
  }

  /** One full scan cycle. Returns every base-passing candidate (PASS/WARN/FAIL). */
  async scanOnce(): Promise<ScreenedCandidate[]> {
    this.baseDropReasons = [];
    const rank = await this.deps.client.getRank({
      chain: CHAIN,
      interval: '5m',
      order_by: 'volume',
      direction: 'desc',
      limit: this.cfg.scanLimit,
      filters: ['renounced', 'frozen', 'not_wash_trading'],
    });

    const candidates = rank.filter((item) => quickFilterRank(item, this.cfg));
    const screened = await runPool(candidates, this.cfg.scanConcurrency, (item) =>
      this.processCandidate(item),
    );
    const passed = screened.filter((c): c is ScreenedCandidate => c !== null);

    // Block hard fails; only PASS / WARN are deliverable.
    const deliverable = passed.filter((c) => c.verdict !== 'FAIL');
    const fresh = deliverable.filter(
      (c) => !this.deps.store.wasRecentlyAlerted(c.mint, this.cfg.dedupeMs),
    );

    // Don't deliver if shutdown began while we were screening — Telegram may be
    // stopping. The fresh candidates stay un-recorded and re-alert on next startup.
    let delivered = false;
    if (fresh.length > 0 && !this.stopped) {
      await this.attachMeteoraLinks(fresh);
      const messages = formatRichMessages(fresh.map((c) => c.view));
      try {
        delivered = await this.deps.notify(messages);
      } catch (err) {
        console.error('[gmgn] notify failed:', err);
      }
      // Record (dedupe) only after delivery, so an undelivered batch re-alerts next cycle.
      if (delivered) {
        for (const c of fresh) {
          try {
            await this.deps.store.record(c.mint, c.symbol, this.cfg.dedupeMs);
          } catch (err) {
            // In-memory dedupe still prevents same-session dupes; flag the restart risk.
            console.error(
              `[gmgn] failed to persist dedupe record for ${c.mint} — ` +
                `it may re-alert after a restart:`,
              err,
            );
          }
          if (this.cfg.autoWatch && this.deps.watchStore) {
            this.deps.watchStore.upsertWatch(c.mint, 50, { symbol: c.symbol });
          }
        }
        console.log(`[gmgn] alerted ${fresh.length} candidate(s).`);
      }
    }

    console.log(
      `[gmgn] cycle: ${rank.length} trending → ${candidates.length} quick-pass → ` +
        `${passed.length} base-pass → ${deliverable.length} deliverable → ${fresh.length} new`,
    );
    // When nothing clears the base filter, surface the top reasons so a misparse
    // (e.g. price→0→mcap 0) or simply "no token matched" is visible in the logs.
    if (passed.length === 0 && this.baseDropReasons.length > 0) {
      console.log(`[gmgn] base-filter drops: ${summarizeReasons(this.baseDropReasons)}`);
    }
    this.lastSummary = {
      trending: rank.length,
      quickPass: candidates.length,
      basePass: passed.length,
      deliverable: deliverable.length,
      fresh: fresh.length,
      delivered,
    };
    return passed;
  }

  /**
   * Best-effort: attach Meteora DLMM pool links to each candidate's view before
   * delivery. Done only for the (few) candidates actually being alerted, and any
   * per-token failure is logged and skipped rather than aborting the alert.
   */
  private async attachMeteoraLinks(candidates: ScreenedCandidate[]): Promise<void> {
    const linker = this.deps.meteora;
    if (!linker) return;
    await Promise.all(
      candidates.map(async (c) => {
        try {
          c.view.meteoraPools = await linker(c.mint);
        } catch (err) {
          console.error(
            `[gmgn] meteora links ${c.mint} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
  }

  /**
   * Fetch detail + run base filter and (if it passes) the full screening workflow
   * for one token. Returns null when the token is filtered out or fetching failed —
   * a single token's failure never aborts the cycle.
   */
  private async processCandidate(item: GmgnRankItem): Promise<ScreenedCandidate | null> {
    const mint = item.address!;
    try {
      const info = await this.deps.client.getTokenInfo(CHAIN, mint);
      if (!info) return null;

      const nowMs = this.now();
      // ATH fallback: only when ath_price is missing, derive ATH from the token's
      // FULL-lifetime kline (hourly candles since launch) — not the recent window,
      // whose high is not an all-time high. baseFilter fails closed if this yields 0.
      let klineAth: number | undefined;
      if (!((infoPrice(info.ath_price) ?? 0) > 0)) {
        const athCandles = await this.fetchAthKline(mint, info, nowMs);
        klineAth = athFromKline(athCandles);
      }
      const base = baseFilter(info, this.cfg, {
        nowMs,
        klineAth,
        fallbackMarketCap: toNum(item.market_cap),
      });
      if (!base.pass) {
        for (const r of base.reasons) this.baseDropReasons.push(r);
        return null;
      }

      // Screening workflow (security → holders/traders → volume authenticity).
      const security = await this.deps.client.getTokenSecurity(CHAIN, mint);
      const sec = screenSecurity(security);

      const [holders, traders] = await Promise.all([
        this.deps.client.getTopHolders(CHAIN, mint, 100),
        this.deps.client.getTopTraders(CHAIN, mint, 100),
      ]);
      const smartMoney = extractSmartMoney(holders, traders);

      // The GMGN flow wants smart money present; enforce it as a WARN (not a hard
      // block) when neither the holder/trader lists nor the info stat show any.
      const smartWalletStat = toNum(info.wallet_tags_stat?.smart_wallets) ?? 0;
      const smActive =
        smartMoney.smHolding + smartMoney.smExited + smartMoney.smUnrealizedPositive > 0;
      const smartMoneyWarnings =
        smartWalletStat < 1 && !smActive ? ['no smart money detected'] : [];

      // Volume authenticity uses the recent 1h window of 5m candles.
      const recentKline = await this.fetchRecentKline(mint, nowMs);
      const volWarnings = analyzeVolume(recentKline, { security, info });

      const warnings = [...sec.warnings, ...smartMoneyWarnings, ...volWarnings];
      const verdict: ScreeningVerdict =
        sec.hardFails.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS';

      const display = buildGmgnDisplay({
        info,
        security,
        holders,
        traders,
        recentKline,
        rankVolume: toNum(item.volume),
        base: {
          price: base.price,
          marketCap: base.marketCap,
          ageHours: base.ageHours,
          athPrice: base.athPrice,
          drawdownPct: base.drawdownPct,
        },
      });
      const view: RichTokenView = {
        ...display,
        kind: 'gmgn',
        mint,
        symbol: info.symbol ?? item.symbol,
        name: info.name ?? item.name,
        chain: 'Solana',
        verdict,
        warnings,
        hardFails: sec.hardFails,
      };

      return {
        mint,
        symbol: info.symbol ?? item.symbol,
        name: info.name ?? item.name,
        price: base.price,
        marketCap: base.marketCap,
        totalFeeSol: base.totalFeeSol,
        ageHours: base.ageHours,
        athPrice: base.athPrice,
        drawdownPct: base.drawdownPct,
        verdict,
        hardFails: sec.hardFails,
        warnings,
        smartMoney,
        links: {
          gmgn: gmgnLink(mint, info),
          jupiter: `https://jup.ag/tokens/${mint}`,
          birdeye: `https://birdeye.so/token/${mint}?chain=solana`,
        },
        view,
      };
    } catch (err) {
      console.error(`[gmgn] screening ${mint} failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  private fetchRecentKline(mint: string, nowMs: number): Promise<GmgnKlineCandle[]> {
    const toSec = Math.floor(nowMs / 1000);
    const fromSec = toSec - 3600; // last 1 hour
    return this.deps.client.getKline(CHAIN, mint, '5m', fromSec, toSec);
  }

  /**
   * Full-lifetime hourly kline for the ATH fallback: from the token's launch
   * (open/creation timestamp) to now, clamped to at most `maxTokenAgeDays` so we
   * never request an unbounded range. Hourly resolution keeps the candle count
   * bounded (≤ ~336 for 14 days) while still capturing the true peak.
   */
  private fetchAthKline(
    mint: string,
    info: GmgnTokenInfo,
    nowMs: number,
  ): Promise<GmgnKlineCandle[]> {
    const toSec = Math.floor(nowMs / 1000);
    const earliest = toSec - this.cfg.maxTokenAgeDays * 24 * 3600;
    const launch = toNum(info.open_timestamp) ?? toNum(info.creation_timestamp);
    const fromSec = launch !== undefined && launch > earliest ? Math.floor(launch) : earliest;
    return this.deps.client.getKline(CHAIN, mint, '1h', fromSec, toSec);
  }
}
