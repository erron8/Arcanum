import { fetchChartData, intervalDurationMs } from '../fetchers/chartData';
import type { FetchChartOptions } from '../fetchers/chartData';
import type { AlertPayload, ChartDataPoint, WatchEntry } from '../models/types';
import type { AlertStore } from './store';
import type { AppConfig } from './config';

/** Injectable candle source (defaults to the live Jupiter fetcher). */
export type ChartFetcher = (mint: string, opts?: FetchChartOptions) => Promise<ChartDataPoint[]>;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts: number, baseMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await delay(baseMs * 2 ** i);
    }
  }
  throw lastErr;
}

function jupiterUrl(mint: string): string {
  return `https://jup.ag/tokens/${mint}`;
}
function birdeyeUrl(mint: string): string {
  return `https://birdeye.so/token/${mint}?chain=solana`;
}

/**
 * Delivers a batch of alerts and returns the mints it ACCEPTED for delivery
 * (e.g. enqueued to at least one authorized subscriber). The monitor only marks
 * those tokens TRIGGERED — anything not accepted stays ARMED and re-fires next
 * cycle, so an alert is never "consumed" without a delivery path.
 */
export type AlertSink = (alerts: AlertPayload[]) => string[] | Promise<string[]>;

export interface TokenSnapshot {
  price: number;
  ath: number;
  drawdownPct: number;
  persistedAth: number;
  stale: boolean;
}

/**
 * Watch loop + per-token state machine. Transport-agnostic: emits {@link AlertPayload}s
 * through a settable {@link AlertSink}, so it is unit-testable without Telegram.
 */
export class AthMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private sink: AlertSink | null = null;
  /** Per-token fetch-failure backoff: mint → { consecutive failures, next allowed time }. */
  private readonly failureState = new Map<string, { count: number; nextRetryAt: number }>();

  private readonly fetcher: ChartFetcher;

  constructor(
    private readonly store: AlertStore,
    private readonly cfg: AppConfig,
    fetcher: ChartFetcher = fetchChartData,
  ) {
    this.fetcher = fetcher;
  }

  setSink(sink: AlertSink): void {
    this.sink = sink;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async (): Promise<void> => {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error('[athMonitor] poll cycle error:', err);
      }
      if (this.running) this.timer = setTimeout(() => void loop(), this.cfg.pollIntervalMs);
    };
    this.timer = setTimeout(() => void loop(), 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Fetch the freshest candle and derive price + reconciled ATH + candle time. */
  private async fetchLatest(
    mint: string,
  ): Promise<{ price: number; computedAth: number; candleTime: number } | null> {
    const data = await withRetry(
      () =>
        this.fetcher(mint, {
          interval: this.cfg.interval,
          candles: this.cfg.candles,
          quote: this.cfg.quote,
          timeoutMs: this.cfg.fetchTimeoutMs,
        }),
      this.cfg.fetchAttempts,
      this.cfg.fetchBackoffMs,
    );
    if (data.length === 0) return null;
    const last = data[data.length - 1]!;
    const computedAth =
      typeof last.athPrice === 'number' && Number.isFinite(last.athPrice)
        ? last.athPrice
        : last.close;
    return { price: last.close, computedAth, candleTime: last.time };
  }

  /** Apply exponential backoff for a token that just failed to fetch. */
  private recordFailure(mint: string): void {
    const prev = this.failureState.get(mint)?.count ?? 0;
    const count = prev + 1;
    // Back off ~1 poll interval, doubling each failure, capped at 30 minutes.
    const backoff = Math.min(this.cfg.pollIntervalMs * 2 ** (count - 1), 30 * 60_000);
    this.failureState.set(mint, { count, nextRetryAt: Date.now() + backoff });
  }

  /** True if the latest candle is older than `multiplier` intervals (stale data). */
  private isStale(candleTime: number): boolean {
    const maxAge = intervalDurationMs(this.cfg.interval) * this.cfg.staleCandleMultiplier;
    return Date.now() - candleTime > maxAge;
  }

  /** Run the state machine for one token. Returns a payload iff an alert fires. */
  private async checkToken(mint: string, entry: WatchEntry): Promise<AlertPayload | null> {
    const latest = await this.fetchLatest(mint);
    if (!latest) return null;

    const stale = this.isStale(latest.candleTime);

    // Quote-aware reconcile: ignore a persisted ATH stored in a different denomination.
    const persistedCompatible = entry.quote === undefined || entry.quote === this.cfg.quote;
    const basePersisted = persistedCompatible ? entry.persistedAth || 0 : 0;
    const ath = Math.max(latest.computedAth, basePersisted);
    // Don't advance the persisted ATH from a stale candle.
    if (!stale) this.store.updatePersistedAth(mint, ath, this.cfg.quote);

    const drawdown = ath > 0 ? Math.max(0, ((ath - latest.price) / ath) * 100) : 0;
    const now = Date.now();

    // Always record the latest observation for /status and /list visibility.
    this.store.recordCheck(mint, { price: latest.price, drawdownPct: drawdown, stale, at: now });

    if (stale) {
      console.warn(
        `[athMonitor] ${mint}: latest candle is stale ` +
          `(${new Date(latest.candleTime).toISOString()}); not alerting this cycle.`,
      );
      return null;
    }

    if (entry.state === 'ARMED') {
      if (drawdown >= entry.threshold) {
        // Do NOT mark TRIGGERED here — only after the sink accepts delivery (pollOnce).
        return {
          mint,
          symbol: entry.symbol,
          price: latest.price,
          ath,
          drawdownPct: drawdown,
          threshold: entry.threshold,
          jupiterUrl: jupiterUrl(mint),
          birdeyeUrl: birdeyeUrl(mint),
        };
      }
    } else {
      // TRIGGERED → re-arm only when cooldown elapsed AND price recovered past hysteresis.
      // Clamp the recovery target to >= 0 so a threshold <= hysteresis can never get
      // stuck forever (re-arm at full recovery / 0% drawdown in that degenerate case).
      const cooled = now - entry.lastAlertAt >= this.cfg.alertCooldownMs;
      const recoverTarget = Math.max(0, entry.threshold - this.cfg.recoveryHysteresisPct);
      const recovered = recoverTarget > 0 ? drawdown < recoverTarget : drawdown <= 0;
      if (cooled && recovered) this.store.markArmed(mint);
    }
    return null;
  }

  /**
   * One full sweep over all watched tokens with bounded concurrency, so a large
   * watch list doesn't make a poll cycle exceed POLL_INTERVAL_MS. One token failing
   * never kills the sweep.
   */
  async pollOnce(): Promise<AlertPayload[]> {
    const now = Date.now();
    // Skip tokens currently in failure backoff so a persistently failing token
    // can't occupy a concurrency slot every cycle and stretch the cycle out.
    const queue = Object.entries(this.store.list()).filter(([mint]) => {
      const fs = this.failureState.get(mint);
      return !fs || now >= fs.nextRetryAt;
    });
    const payloads: AlertPayload[] = [];
    const limit = Math.max(1, Math.min(this.cfg.pollConcurrency, queue.length || 1));

    const worker = async (): Promise<void> => {
      for (;;) {
        const item = queue.shift(); // atomic in single-threaded JS
        if (!item) return;
        const [mint, entry] = item;
        try {
          const p = await this.checkToken(mint, entry);
          this.failureState.delete(mint); // success clears any backoff
          if (p) payloads.push(p);
        } catch (err) {
          this.recordFailure(mint);
          console.error(`[athMonitor] ${mint} failed:`, err instanceof Error ? err.message : err);
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));

    if (payloads.length > 0 && this.sink) {
      let accepted: string[] = [];
      try {
        accepted = await this.sink(payloads);
      } catch (err) {
        console.error('[athMonitor] sink failed:', err);
      }
      // Consume (mark TRIGGERED) only the alerts the sink accepted for delivery.
      const acceptedSet = new Set(accepted);
      const now = Date.now();
      for (const p of payloads) {
        if (acceptedSet.has(p.mint)) this.store.markTriggered(p.mint, now);
      }
    }
    return payloads;
  }

  /** On-demand snapshot for the `/status` and `/watch` commands. */
  async snapshot(mint: string): Promise<TokenSnapshot | null> {
    const entry = this.store.get(mint);
    const latest = await this.fetchLatest(mint);
    if (!latest) return null;
    const compatible = entry?.quote === undefined || entry.quote === this.cfg.quote;
    const persistedAth = compatible ? (entry?.persistedAth ?? 0) : 0;
    const ath = Math.max(latest.computedAth, persistedAth);
    const drawdownPct = ath > 0 ? Math.max(0, ((ath - latest.price) / ath) * 100) : 0;
    return { price: latest.price, ath, drawdownPct, persistedAth, stale: this.isStale(latest.candleTime) };
  }
}
