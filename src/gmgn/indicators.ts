import { toNum } from './client';
import type { GmgnKlineCandle } from './types';

/**
 * Technical indicators used by the Zap In scanner. Pure and self-contained so they
 * can be unit-tested without any network access. Inputs are GMGN OHLCV candles in
 * chronological order (oldest → newest); malformed candles are skipped defensively.
 */

/**
 * Wilder's Average True Range over `period`. Returns an array aligned to the input
 * bars: entries before the first full window are `NaN`. The seed ATR is the simple
 * mean of the first `period` true ranges, then smoothed with Wilder's RMA.
 */
export function computeAtr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number[] {
  const n = closes.length;
  const atr: number[] = new Array(n).fill(NaN);
  if (period < 1 || n < period) return atr;

  const tr: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = highs[i]! - lows[i]!;
    } else {
      const h = highs[i]!;
      const l = lows[i]!;
      const pc = closes[i - 1]!;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
  }

  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i]!;
  atr[period - 1] = seed / period;
  for (let i = period; i < n; i++) {
    atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  return atr;
}

export interface SupertrendResult {
  /** 'up' = price above the Supertrend line (bullish); 'down' = below (bearish). */
  direction: 'up' | 'down';
  /** Convenience: true when direction is 'up'. */
  bullish: boolean;
  /** The Supertrend line value at the most recent bar. */
  value: number;
}

/**
 * Compute the Supertrend indicator (ATR-band trend follower) and return its state at
 * the most recent bar. Uses the standard band carry-over rules; the first band is
 * seeded from the initial close vs. its basic upper band.
 *
 * Returns null when there aren't enough clean candles to establish a trend
 * (`< period + 1`), so the caller fails closed rather than acting on noise.
 */
export function computeSupertrend(
  candles: GmgnKlineCandle[],
  period = 10,
  multiplier = 3,
): SupertrendResult | null {
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  for (const c of candles) {
    const h = toNum(c.high);
    const l = toNum(c.low);
    const cl = toNum(c.close);
    if (h === undefined || l === undefined || cl === undefined) continue;
    highs.push(h);
    lows.push(l);
    closes.push(cl);
  }

  const n = closes.length;
  if (period < 1 || n < period + 1) return null;

  const atr = computeAtr(highs, lows, closes, period);
  const finalUpper: number[] = new Array(n).fill(0);
  const finalLower: number[] = new Array(n).fill(0);
  const line: number[] = new Array(n).fill(0);
  const dir: Array<'up' | 'down'> = new Array(n).fill('up');

  const start = period - 1; // first index with a defined ATR
  for (let i = start; i < n; i++) {
    const hl2 = (highs[i]! + lows[i]!) / 2;
    const basicUpper = hl2 + multiplier * atr[i]!;
    const basicLower = hl2 - multiplier * atr[i]!;

    if (i === start) {
      finalUpper[i] = basicUpper;
      finalLower[i] = basicLower;
      if (closes[i]! > basicUpper) {
        dir[i] = 'up';
        line[i] = basicLower;
      } else {
        dir[i] = 'down';
        line[i] = basicUpper;
      }
      continue;
    }

    finalUpper[i] =
      basicUpper < finalUpper[i - 1]! || closes[i - 1]! > finalUpper[i - 1]!
        ? basicUpper
        : finalUpper[i - 1]!;
    finalLower[i] =
      basicLower > finalLower[i - 1]! || closes[i - 1]! < finalLower[i - 1]!
        ? basicLower
        : finalLower[i - 1]!;

    if (line[i - 1] === finalUpper[i - 1]) {
      // Previously bearish (line was the upper band): flip up only on a close above it.
      if (closes[i]! > finalUpper[i]!) {
        line[i] = finalLower[i]!;
        dir[i] = 'up';
      } else {
        line[i] = finalUpper[i]!;
        dir[i] = 'down';
      }
    } else {
      // Previously bullish (line was the lower band): flip down only on a close below it.
      if (closes[i]! < finalLower[i]!) {
        line[i] = finalUpper[i]!;
        dir[i] = 'down';
      } else {
        line[i] = finalLower[i]!;
        dir[i] = 'up';
      }
    }
  }

  const last = n - 1;
  return { direction: dir[last]!, bullish: dir[last] === 'up', value: line[last]! };
}
