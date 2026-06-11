import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/** Atomic temp→rename writer (POSIX-atomic). Injectable for testing. */
export type ScreenedWriter = (path: string, body: string) => Promise<void>;

const atomicWriter: ScreenedWriter = async (path, body) => {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, path);
};

interface ScreenedRecord {
  alertedAt: number; // epoch ms
  symbol?: string;
}

type ScreenedData = Record<string, ScreenedRecord>;

export interface GmgnScreenedStoreOptions {
  writer?: ScreenedWriter;
  now?: () => number;
}

/**
 * Dedupe store for GMGN screening alerts, persisted to `./data/gmgn-screened.json`.
 *
 * Records the last time each mint was alerted so the scanner does not re-alert the
 * same token within `GMGN_DEDUPE_MS`. Writes are atomic (temp → rename) so a crash
 * mid-write cannot corrupt the file. Stale records (older than the dedupe window)
 * are pruned on write to keep the file bounded.
 */
export class GmgnScreenedStore {
  private data: ScreenedData = {};
  private readonly path: string;
  private readonly writer: ScreenedWriter;
  private readonly now: () => number;

  constructor(path: string, opts: GmgnScreenedStoreOptions = {}) {
    this.path = path;
    this.writer = opts.writer ?? atomicWriter;
    this.now = opts.now ?? (() => Date.now());
  }

  async init(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      this.data = this.sanitize(JSON.parse(raw));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.data = {};
      } else if (err instanceof SyntaxError) {
        console.error(`[gmgn-store] corrupt ${this.path}, starting empty:`, err.message);
        this.data = {};
      } else {
        throw err;
      }
    }
  }

  private sanitize(parsed: unknown): ScreenedData {
    const out: ScreenedData = {};
    if (!parsed || typeof parsed !== 'object') return out;
    for (const [mint, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Partial<ScreenedRecord>;
      if (typeof v.alertedAt !== 'number' || !Number.isFinite(v.alertedAt) || v.alertedAt < 0) {
        continue;
      }
      out[mint] = {
        alertedAt: v.alertedAt,
        symbol: typeof v.symbol === 'string' ? v.symbol : undefined,
      };
    }
    return out;
  }

  /** True if this mint was alerted within `dedupeMs` of now. */
  wasRecentlyAlerted(mint: string, dedupeMs: number): boolean {
    const rec = this.data[mint];
    if (!rec) return false;
    return this.now() - rec.alertedAt < dedupeMs;
  }

  /**
   * Record an alert for a mint (in memory) and persist, pruning entries past the
   * window. The in-memory update happens first, so same-session dedupe holds even
   * if the disk write fails; a write failure is **rethrown** so the caller can warn
   * that the record may not survive a restart (rather than silently risking dupes).
   */
  async record(mint: string, symbol: string | undefined, dedupeMs: number): Promise<void> {
    const now = this.now();
    this.data[mint] = { alertedAt: now, symbol };
    // Prune stale records so the file can't grow without bound.
    for (const [m, rec] of Object.entries(this.data)) {
      if (now - rec.alertedAt >= dedupeMs) delete this.data[m];
    }
    await this.flush();
  }

  /** Number of tracked mints (for inspection/tests). */
  size(): number {
    return Object.keys(this.data).length;
  }

  /** Persist to disk. Throws on write failure so callers can surface the risk. */
  private async flush(): Promise<void> {
    await this.writer(this.path, JSON.stringify(this.data, null, 2));
  }
}
