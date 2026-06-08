/**
 * Canonical data model shared across fetchers, indicators and the alerting layer.
 *
 * All indicator fields are optional + nullable: `null` means "not computable yet"
 * (e.g. inside an indicator's warm-up window), `undefined` means "not attached".
 */
export interface ChartDataPoint {
  /** Epoch milliseconds (Jupiter `time` is seconds — already ×1000 here). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;

  // --- existing indicators (4) ---
  rsi?: number | null;
  bollingerUpper?: number | null;
  bollingerMiddle?: number | null;
  bollingerLower?: number | null;
  macd?: number | null;
  macdSignal?: number | null;
  macdHistogram?: number | null;
  supertrend?: number | null;
  supertrendDirection?: number | null; // 1 = uptrend, -1 = downtrend

  // --- fifth indicator: ATH drawdown ---
  athPrice?: number | null;
  drawdownFromATH?: number | null; // percent, 0 = at ATH
}

/** Persisted per-mint alert configuration + runtime state. */
export type AlertState = 'ARMED' | 'TRIGGERED';

export interface WatchEntry {
  symbol?: string;
  threshold: number;     // drawdown percent that fires an alert
  persistedAth: number;  // monotonic-upward ATH; denominated in `quote`; 0 = unknown
  quote?: 'native' | 'usd'; // denomination of persistedAth; undefined = legacy/unknown
  state: AlertState;
  lastAlertAt: number;   // epoch ms, 0 = never alerted
  // --- runtime observability (last poll) ---
  lastCheckedAt?: number;    // epoch ms of the last completed check
  lastPrice?: number;        // last observed price (in `quote`)
  lastDrawdownPct?: number;  // last observed drawdown from ATH
  lastStale?: boolean;       // whether the last candle was stale
}

export type StoreData = Record<string, WatchEntry>;

/** Transport-agnostic alert emitted by the monitor. */
export interface AlertPayload {
  mint: string;
  symbol?: string;
  price: number;        // current price proxy (latest close)
  ath: number;          // reconciled ATH
  drawdownPct: number;  // current drawdown from ATH
  threshold: number;
  jupiterUrl: string;
  birdeyeUrl: string;
}
