import type { ChartDataPoint } from '../models/types';
import {
  calculateRSI,
  calculateBollinger,
  calculateMACD,
  calculateSupertrend,
  calculateATHDrawdown,
} from '../utils/indicators';

/**
 * Local duplicate of the canonical {@link ChartDataPoint}. Kept intentionally in
 * sync with `src/models/types.ts` — including the two ATH fields below.
 */
interface LocalChartDataPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rsi?: number | null;
  bollingerUpper?: number | null;
  bollingerMiddle?: number | null;
  bollingerLower?: number | null;
  macd?: number | null;
  macdSignal?: number | null;
  macdHistogram?: number | null;
  supertrend?: number | null;
  supertrendDirection?: number | null;
  athPrice?: number | null; // kept in sync with canonical model
  drawdownFromATH?: number | null; // percent, 0 = at ATH
}

/** Intervals accepted by Jupiter datapi (verified live). */
export const JUPITER_INTERVALS = [
  '1_MINUTE',
  '3_MINUTE',
  '5_MINUTE',
  '15_MINUTE',
  '30_MINUTE',
  '1_HOUR',
  '2_HOUR',
  '4_HOUR',
  '8_HOUR',
  '12_HOUR',
  '1_DAY',
  '1_WEEK',
  '1_MONTH',
] as const;

export type JupiterInterval = (typeof JUPITER_INTERVALS)[number];

/** Friendly aliases (e.g. `1h`) → canonical Jupiter interval. */
const INTERVAL_ALIASES: Record<string, JupiterInterval> = {
  '1m': '1_MINUTE',
  '3m': '3_MINUTE',
  '5m': '5_MINUTE',
  '15m': '15_MINUTE',
  '30m': '30_MINUTE',
  '1h': '1_HOUR',
  '2h': '2_HOUR',
  '4h': '4_HOUR',
  '8h': '8_HOUR',
  '12h': '12_HOUR',
  '1d': '1_DAY',
  '1w': '1_WEEK',
  '1mo': '1_MONTH',
};

const INTERVAL_SET = new Set<string>(JUPITER_INTERVALS);

/** Normalize an interval string to a valid Jupiter interval, or null if unknown. */
export function normalizeInterval(raw: string): JupiterInterval | null {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  if (INTERVAL_SET.has(upper)) return upper as JupiterInterval;
  const alias = INTERVAL_ALIASES[trimmed.toLowerCase()];
  return alias ?? null;
}

const MINUTE_MS = 60_000;
const INTERVAL_MS: Record<JupiterInterval, number> = {
  '1_MINUTE': MINUTE_MS,
  '3_MINUTE': 3 * MINUTE_MS,
  '5_MINUTE': 5 * MINUTE_MS,
  '15_MINUTE': 15 * MINUTE_MS,
  '30_MINUTE': 30 * MINUTE_MS,
  '1_HOUR': 60 * MINUTE_MS,
  '2_HOUR': 120 * MINUTE_MS,
  '4_HOUR': 240 * MINUTE_MS,
  '8_HOUR': 480 * MINUTE_MS,
  '12_HOUR': 720 * MINUTE_MS,
  '1_DAY': 1_440 * MINUTE_MS,
  '1_WEEK': 7 * 1_440 * MINUTE_MS,
  '1_MONTH': 30 * 1_440 * MINUTE_MS,
};

/** Duration of one candle of the given interval, in ms. Defaults to 1 day if unknown. */
export function intervalDurationMs(interval: string): number {
  const norm = normalizeInterval(interval);
  return norm ? INTERVAL_MS[norm] : INTERVAL_MS['1_DAY'];
}

interface RawCandle {
  time: number; // seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface RawResponse {
  candles?: unknown;
}

export interface FetchChartOptions {
  /** Jupiter interval token or friendly alias (e.g. '1h'). Default '1_DAY'. */
  interval?: string;
  /** Number of candles to request. Default 1000. */
  candles?: number;
  /** Upper time bound in epoch ms. Default now. */
  to?: number;
  /** Price denomination. Default 'native' (SOL). Use 'usd' for USD display. */
  quote?: 'native' | 'usd';
  /** Optional fetch timeout in ms. Default 15000. */
  timeoutMs?: number;
}

const JUPITER_BASE = 'https://datapi.jup.ag/v2/charts';
const DEFAULT_INTERVAL: JupiterInterval = '1_DAY';

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate + normalize a raw candle. Returns null if any OHLCV field is missing
 * or non-finite, so NaN/undefined never leak into the indicators or output.
 */
function toRawCandle(c: unknown): RawCandle | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  if (
    !isFiniteNum(o.time) ||
    !isFiniteNum(o.open) ||
    !isFiniteNum(o.high) ||
    !isFiniteNum(o.low) ||
    !isFiniteNum(o.close) ||
    !isFiniteNum(o.volume)
  ) {
    return null;
  }
  return {
    time: o.time,
    open: o.open,
    high: o.high,
    low: o.low,
    close: o.close,
    volume: o.volume,
  };
}

/**
 * Pure transform: validated raw candles → ChartDataPoints with all five
 * indicators attached. Exposed for unit testing without network access.
 */
export function buildChartData(rawCandles: unknown): ChartDataPoint[] {
  const arr = Array.isArray(rawCandles) ? rawCandles : [];
  const cleaned: RawCandle[] = [];
  for (const c of arr) {
    const rc = toRawCandle(c);
    if (rc) cleaned.push(rc);
  }

  const highs = cleaned.map((c) => c.high);
  const lows = cleaned.map((c) => c.low);
  const closes = cleaned.map((c) => c.close);

  const rsi = calculateRSI(closes);
  const boll = calculateBollinger(closes);
  const macd = calculateMACD(closes);
  const st = calculateSupertrend(highs, lows, closes);
  const ath = calculateATHDrawdown(highs, closes);

  const points: LocalChartDataPoint[] = cleaned.map((c, i) => ({
    time: c.time * 1000, // seconds → ms
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    rsi: rsi[i] ?? null,
    bollingerUpper: boll[i]?.upper ?? null,
    bollingerMiddle: boll[i]?.middle ?? null,
    bollingerLower: boll[i]?.lower ?? null,
    macd: macd[i]?.macd ?? null,
    macdSignal: macd[i]?.signal ?? null,
    macdHistogram: macd[i]?.histogram ?? null,
    supertrend: st[i]?.value ?? null,
    supertrendDirection: st[i]?.direction ?? null,
    athPrice: ath[i]?.ath ?? null,
    drawdownFromATH: ath[i]?.drawdownPct ?? null,
  }));

  return points;
}

/**
 * Fetch OHLCV candles from Jupiter datapi and attach all five indicators.
 * Candles arrive oldest→newest; the last element is the current-price proxy.
 */
export async function fetchChartData(
  mint: string,
  opts: FetchChartOptions = {},
): Promise<ChartDataPoint[]> {
  const interval = normalizeInterval(opts.interval ?? DEFAULT_INTERVAL);
  if (!interval) {
    throw new Error(
      `Invalid interval '${opts.interval}'. Valid: ${JUPITER_INTERVALS.join(', ')}`,
    );
  }
  const candles = opts.candles ?? 1000;
  const to = opts.to ?? Date.now();
  const quote = opts.quote ?? 'native'; // SOL-denominated by default
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const url =
    `${JUPITER_BASE}/${encodeURIComponent(mint)}` +
    `?interval=${encodeURIComponent(interval)}` +
    `&to=${to}&candles=${candles}&type=price&quote=${quote}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let json: RawResponse;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Jupiter datapi ${res.status} ${res.statusText} for ${mint}`);
    }
    json = (await res.json()) as RawResponse;
  } finally {
    clearTimeout(timer);
  }

  return buildChartData(json.candles);
}

interface AssetSearchResult {
  id?: string;
  symbol?: string;
  name?: string;
}

/**
 * Best-effort token symbol lookup via Jupiter datapi asset search. Returns the
 * symbol for an exact mint match, or undefined if not found / on any error.
 */
export async function fetchTokenSymbol(mint: string, timeoutMs = 10_000): Promise<string | undefined> {
  const url = `https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(mint)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) return undefined;
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return undefined;
    const match = (json as AssetSearchResult[]).find((a) => a?.id === mint);
    const symbol = match?.symbol;
    return typeof symbol === 'string' && symbol.trim() !== '' ? symbol.trim() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
