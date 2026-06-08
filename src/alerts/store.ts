import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { StoreData, WatchEntry } from '../models/types';

/**
 * JSON-file persistence for watched tokens.
 *
 * - Atomic writes (write temp → rename) survive a crash mid-write.
 * - `persistedAth` only ever moves up here; it is lowered solely by {@link resetAth}.
 * - Writes are debounced so a whole poll cycle costs at most one disk write.
 */
/** Atomic temp→rename writer (POSIX-atomic). Injectable for testing. */
export type StoreWriter = (path: string, body: string) => Promise<void>;

const atomicWriter: StoreWriter = async (path, body) => {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, path);
};

export interface AlertStoreOptions {
  flushDelayMs?: number;
  writer?: StoreWriter;
}

export class AlertStore {
  private data: StoreData = {};
  private readonly path: string;
  private readonly flushDelayMs: number;
  private readonly writer: StoreWriter;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic version bumped on every mutation; lastWrittenVersion tracks what has
  // actually hit disk. Pending iff they differ. This closes the mutation-during-write
  // race that a boolean dirty flag cannot express.
  private version = 0;
  private lastWrittenVersion = 0;

  constructor(path: string, opts: AlertStoreOptions = {}) {
    this.path = path;
    this.flushDelayMs = opts.flushDelayMs ?? 1_000;
    this.writer = opts.writer ?? atomicWriter;
  }

  async init(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.data = this.sanitize(parsed);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.data = {};
      } else if (err instanceof SyntaxError) {
        console.error(`[store] corrupt ${this.path}, starting empty:`, err.message);
        this.data = {};
      } else {
        throw err;
      }
    }
  }

  private sanitize(parsed: unknown): StoreData {
    const out: StoreData = {};
    if (!parsed || typeof parsed !== 'object') return out;

    const finiteNonNeg = (x: unknown, def: number): number =>
      typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : def;
    const optFiniteNonNeg = (x: unknown): number | undefined =>
      typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;

    let dropped = 0;
    for (const [mint, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        dropped++;
        continue;
      }
      const v = value as Partial<WatchEntry>;
      // Validate threshold the same way runtime config does: a finite (0, 100].
      if (
        typeof v.threshold !== 'number' ||
        !Number.isFinite(v.threshold) ||
        v.threshold <= 0 ||
        v.threshold > 100
      ) {
        console.error(`[store] dropping '${mint}': invalid threshold ${String(v.threshold)}.`);
        dropped++;
        continue;
      }
      out[mint] = {
        symbol: typeof v.symbol === 'string' ? v.symbol : undefined,
        threshold: v.threshold,
        persistedAth: finiteNonNeg(v.persistedAth, 0),
        quote: v.quote === 'native' || v.quote === 'usd' ? v.quote : undefined,
        state: v.state === 'TRIGGERED' ? 'TRIGGERED' : 'ARMED',
        lastAlertAt: finiteNonNeg(v.lastAlertAt, 0),
        lastCheckedAt: optFiniteNonNeg(v.lastCheckedAt),
        lastPrice: optFiniteNonNeg(v.lastPrice),
        lastDrawdownPct: optFiniteNonNeg(v.lastDrawdownPct),
        lastStale: typeof v.lastStale === 'boolean' ? v.lastStale : undefined,
      };
    }
    if (dropped > 0) console.warn(`[store] dropped ${dropped} invalid watch entr(ies) on load.`);
    return out;
  }

  // --- reads ---------------------------------------------------------------
  /** Returns a shallow copy per entry so callers cannot mutate internal state. */
  list(): StoreData {
    const out: StoreData = {};
    for (const [mint, entry] of Object.entries(this.data)) out[mint] = { ...entry };
    return out;
  }

  /** Returns a copy so callers cannot mutate internal state without going through the API. */
  get(mint: string): WatchEntry | undefined {
    const entry = this.data[mint];
    return entry ? { ...entry } : undefined;
  }

  has(mint: string): boolean {
    return mint in this.data;
  }

  // --- mutations -----------------------------------------------------------
  /**
   * Add or update a watch. Preserves existing state/ATH/quote when already present.
   * Note: `quote` is intentionally NOT settable here — it is owned by
   * {@link updatePersistedAth} so that persistedAth and its denomination always
   * change together (changing quote without rebasing the ATH would corrupt it).
   */
  upsertWatch(mint: string, threshold: number, opts: { symbol?: string } = {}): WatchEntry {
    const existing = this.data[mint];
    const entry: WatchEntry = existing
      ? { ...existing, threshold, symbol: opts.symbol ?? existing.symbol }
      : { threshold, symbol: opts.symbol, persistedAth: 0, state: 'ARMED', lastAlertAt: 0 };
    this.data[mint] = entry;
    this.scheduleFlush();
    return { ...entry };
  }

  remove(mint: string): boolean {
    if (!(mint in this.data)) return false;
    delete this.data[mint];
    this.scheduleFlush();
    return true;
  }

  setThreshold(mint: string, pct: number): boolean {
    const entry = this.data[mint];
    if (!entry) return false;
    entry.threshold = pct;
    this.scheduleFlush();
    return true;
  }

  setThresholdAll(pct: number): number {
    let count = 0;
    for (const entry of Object.values(this.data)) {
      entry.threshold = pct;
      count++;
    }
    if (count > 0) this.scheduleFlush();
    return count;
  }

  /**
   * Raise persistedAth toward `ath`, in denomination `quote`.
   * - If `quote` differs from the entry's stored quote, the existing ATH is in an
   *   incompatible denomination → rebase to `ath` (set, not max) and stamp the quote.
   * - Otherwise it is upward-only. Returns true if anything changed.
   */
  updatePersistedAth(mint: string, ath: number, quote?: 'native' | 'usd'): boolean {
    const entry = this.data[mint];
    if (!entry || !Number.isFinite(ath)) return false;

    if (quote !== undefined && entry.quote !== undefined && entry.quote !== quote) {
      entry.persistedAth = ath; // rebase: old value was a different denomination
      entry.quote = quote;
      this.scheduleFlush();
      return true;
    }

    let changed = false;
    if (ath > entry.persistedAth) {
      entry.persistedAth = ath;
      changed = true;
    }
    if (quote !== undefined && entry.quote !== quote) {
      entry.quote = quote; // stamp denomination on a legacy/unknown entry
      changed = true;
    }
    if (changed) this.scheduleFlush();
    return changed;
  }

  /** The only path that lowers persistedAth — resets to 0 and re-arms. */
  resetAth(mint: string): boolean {
    const entry = this.data[mint];
    if (!entry) return false;
    entry.persistedAth = 0;
    entry.state = 'ARMED';
    entry.lastAlertAt = 0;
    this.scheduleFlush();
    return true;
  }

  setSymbol(mint: string, symbol: string): void {
    const entry = this.data[mint];
    if (!entry) return;
    entry.symbol = symbol;
    this.scheduleFlush();
  }

  /** Record the result of a poll for observability (/status, /list). */
  recordCheck(
    mint: string,
    info: { price: number; drawdownPct: number; stale: boolean; at: number },
  ): void {
    const entry = this.data[mint];
    if (!entry) return;
    entry.lastCheckedAt = info.at;
    entry.lastPrice = info.price;
    entry.lastDrawdownPct = info.drawdownPct;
    entry.lastStale = info.stale;
    this.scheduleFlush();
  }

  markTriggered(mint: string, at: number): void {
    const entry = this.data[mint];
    if (!entry) return;
    entry.state = 'TRIGGERED';
    entry.lastAlertAt = at;
    this.scheduleFlush();
  }

  markArmed(mint: string): void {
    const entry = this.data[mint];
    if (!entry) return;
    entry.state = 'ARMED';
    this.scheduleFlush();
  }

  // --- persistence ---------------------------------------------------------
  private scheduleFlush(): void {
    this.version++;
    this.queueFlush();
  }

  private queueFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow().catch((e) => {
        // Still pending (lastWrittenVersion not advanced); queue another attempt
        // without bumping the mutation version.
        console.error('[store] flush failed, will retry:', e);
        this.queueFlush();
      });
    }, this.flushDelayMs);
  }

  /**
   * Force-write any pending changes immediately (used on shutdown).
   *
   * Drains in a loop: each iteration snapshots the current version and serializes,
   * then writes. If a mutation lands during the (async) write, the version advances
   * and the loop writes the newer snapshot too — so no change is silently dropped.
   * On a write error, lastWrittenVersion is not advanced (the change stays pending)
   * and the error is propagated to the caller.
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.version !== this.lastWrittenVersion) {
      const v = this.version;
      const body = JSON.stringify(this.data, null, 2);
      await this.writer(this.path, body); // throws → lastWrittenVersion unchanged
      this.lastWrittenVersion = v;
    }
  }
}
