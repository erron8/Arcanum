/**
 * Pure technical-indicator functions. All are causal (no look-ahead) and never
 * mutate their inputs. Index `i` of the output corresponds to candle `i`.
 *
 * `null` marks an unwarmed / undefined slot rather than a fabricated value.
 */

// ---------------------------------------------------------------------------
// 1. RSI (Wilder smoothing)
// ---------------------------------------------------------------------------
export function calculateRSI(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const g = change > 0 ? change : 0;
    const l = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Bollinger Bands (SMA ± mult·σ, population stddev)
// ---------------------------------------------------------------------------
export interface BollingerPoint {
  upper: number | null;
  middle: number | null;
  lower: number | null;
}

export function calculateBollinger(
  closes: number[],
  period = 20,
  mult = 2,
): BollingerPoint[] {
  const out: BollingerPoint[] = closes.map(() => ({ upper: null, middle: null, lower: null }));
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - mean;
      variance += d * d;
    }
    const sd = Math.sqrt(variance / period);
    out[i] = { middle: mean, upper: mean + mult * sd, lower: mean - mult * sd };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. MACD (EMA fast/slow + signal EMA)
// ---------------------------------------------------------------------------
function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface MacdPoint {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

export function calculateMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdPoint[] {
  const out: MacdPoint[] = closes.map(() => ({ macd: null, signal: null, histogram: null }));
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: (number | null)[] = closes.map((_, i) => {
    const f = emaFast[i];
    const s = emaSlow[i];
    return f !== null && s !== null ? f - s : null;
  });

  const firstIdx = macdLine.findIndex((v) => v !== null);
  if (firstIdx < 0) return out;

  const slice = macdLine.slice(firstIdx).map((v) => v as number);
  const sig = ema(slice, signalPeriod);
  for (let i = 0; i < slice.length; i++) {
    const gi = firstIdx + i;
    const m = macdLine[gi];
    const sg = sig[i];
    out[gi] = {
      macd: m,
      signal: sg,
      histogram: m !== null && sg !== null ? m - sg : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Supertrend (ATR-based trailing stop)
// ---------------------------------------------------------------------------
export interface SupertrendPoint {
  value: number | null;
  direction: number | null; // 1 = uptrend, -1 = downtrend
}

export function calculateSupertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 10,
  mult = 3,
): SupertrendPoint[] {
  const n = closes.length;
  const out: SupertrendPoint[] = closes.map(() => ({ value: null, direction: null }));
  if (n === 0) return out;

  // True Range
  const tr: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = highs[i] - lows[i];
    } else {
      const pc = closes[i - 1];
      tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - pc), Math.abs(lows[i] - pc));
    }
  }

  // ATR (Wilder)
  const atr: (number | null)[] = new Array(n).fill(null);
  if (n >= period) {
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    let a = sum / period;
    atr[period - 1] = a;
    for (let i = period; i < n; i++) {
      a = (a * (period - 1) + tr[i]) / period;
      atr[i] = a;
    }
  }

  let prevUpper = 0;
  let prevLower = 0;
  let prevSt = 0;
  let prevDir = 1;
  let prevAtr: number | null = null;

  for (let i = 0; i < n; i++) {
    const a = atr[i];
    if (a === null) {
      prevAtr = null;
      continue;
    }
    const hl2 = (highs[i] + lows[i]) / 2;
    let upper = hl2 + mult * a;
    let lower = hl2 - mult * a;

    if (prevAtr !== null) {
      upper = upper < prevUpper || closes[i - 1] > prevUpper ? upper : prevUpper;
      lower = lower > prevLower || closes[i - 1] < prevLower ? lower : prevLower;
    }

    let dir: number;
    if (prevSt === 0) {
      dir = closes[i] <= upper ? -1 : 1;
    } else if (prevSt === prevUpper) {
      dir = closes[i] > upper ? 1 : -1;
    } else {
      dir = closes[i] < lower ? -1 : 1;
    }
    const st = dir === 1 ? lower : upper;

    out[i] = { value: st, direction: dir };
    prevUpper = upper;
    prevLower = lower;
    prevSt = st;
    prevDir = dir;
    prevAtr = a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. ATH drawdown — the fifth indicator (the focus of this project)
// ---------------------------------------------------------------------------
export interface AthDrawdownPoint {
  ath: number | null;
  drawdownPct: number | null;
}

/**
 * Causal running all-time-high and percent drawdown from it.
 *
 * Rules:
 *  - Running max over highs[0..i]; if highs[k] is NaN/missing, fall back to closes[k].
 *  - drawdownPct = max(0, (ath - close) / ath * 100). A fresh ATH ⇒ 0.
 *  - Index 0 is defined whenever a valid price exists (a single candle's ATH is itself).
 *  - `ath` is null only while no valid price has yet been seen.
 *  - `ath <= 0` ⇒ drawdownPct = null (division guard).
 */
export function calculateATHDrawdown(highs: number[], closes: number[]): AthDrawdownPoint[] {
  const n = Math.max(highs.length, closes.length);
  const out: AthDrawdownPoint[] = [];
  let runningMax: number | null = null;

  for (let i = 0; i < n; i++) {
    const h = highs[i];
    const c = closes[i];

    const validHigh = typeof h === 'number' && Number.isFinite(h);
    const validClose = typeof c === 'number' && Number.isFinite(c);

    // The candle's high feeds the running max; fall back to close when high is missing/NaN.
    const candleHigh: number | null = validHigh ? h : validClose ? c : null;

    if (candleHigh !== null) {
      runningMax = runningMax === null ? candleHigh : Math.max(runningMax, candleHigh);
    }

    if (runningMax === null) {
      out.push({ ath: null, drawdownPct: null });
      continue;
    }

    const ath = runningMax;
    const closeVal: number | null = validClose ? c : candleHigh;

    if (ath <= 0 || closeVal === null) {
      out.push({ ath, drawdownPct: null });
      continue;
    }

    const drawdownPct = Math.max(0, ((ath - closeVal) / ath) * 100);
    out.push({ ath, drawdownPct });
  }
  return out;
}
