/**
 * Minimal client for Meteora's DLMM Data API. Given a Solana token mint, it returns
 * the DLMM pools containing that token, mapped to compact link metadata for alerts.
 *
 * Read-only and best-effort: the caller treats a thrown error or empty result as
 * "no Meteora links", so a Meteora outage never blocks an alert.
 */

/** Meteora app pool page (where a pool link points). */
export function meteoraPoolUrl(poolAddress: string): string {
  return `https://app.meteora.ag/dlmm/${poolAddress}`;
}

/** Compact pool info surfaced in alerts. */
export interface MeteoraPoolLink {
  poolAddress: string;
  /**
   * Symbol of the OTHER side of the pair (the quote — SOL/USDC/etc.). The base side is
   * always the token being looked up, so the renderer labels pools as `<token>/<quote>`
   * (Meteora sometimes omits the base token's symbol, e.g. for DBC pools).
   */
  quoteSymbol?: string;
  volume24h?: number;
  tvl?: number;
  /** DLMM bin step (price granularity). */
  binStep?: number;
  /** Base fee as a percentage (e.g. 0.04 = 0.04%). */
  baseFeePct?: number;
  url: string;
}

/** Resolves the DLMM pool links for a mint (best-effort; empty on no pools/failure). */
export type MeteoraLinker = (mint: string) => Promise<MeteoraPoolLink[]>;

/** Loosely-typed subset of a `/pools` row (external API; read defensively). */
interface MeteoraPoolRow {
  address?: string;
  name?: string;
  token_x?: { address?: string; symbol?: string };
  token_y?: { address?: string; symbol?: string };
  tvl?: number | string;
  volume?: Record<string, number | string | undefined>;
  pool_config?: { bin_step?: number | string; base_fee_pct?: number | string };
  is_blacklisted?: boolean;
}

/** Minimal response shape; the global `fetch` Response satisfies it. */
export interface MeteoraFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface MeteoraRequestInit {
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/** Injectable fetch seam so the client is unit-testable without network access. */
export type MeteoraFetch = (url: string, init: MeteoraRequestInit) => Promise<MeteoraFetchResponse>;

const defaultFetch: MeteoraFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<MeteoraFetchResponse>;

export interface MeteoraClientDeps {
  fetch?: MeteoraFetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface MeteoraClientOptions {
  baseUrl: string;
  maxPools?: number;
  attempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Coerce a string-or-number field to a finite number, or undefined. */
function toNum(x: unknown): number | undefined {
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export class MeteoraClient {
  private readonly baseUrl: string;
  private readonly maxPools: number;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: MeteoraFetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: MeteoraClientOptions, deps: MeteoraClientDeps = {}) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.maxPools = Math.max(1, opts.maxPools ?? 5);
    this.attempts = Math.max(1, opts.attempts ?? 3);
    this.backoffMs = Math.max(0, opts.backoffMs ?? 500);
    this.timeoutMs = Math.max(1, opts.timeoutMs ?? 8_000);
    this.fetchImpl = deps.fetch ?? defaultFetch;
    this.sleep = deps.sleep ?? realSleep;
  }

  /**
   * Return DLMM pools containing `mint`, sorted by TVL desc and capped at `maxPools`.
   * Tries the broad `query=<mint>` search first (filtering client-side to the exact
   * mint), then falls back to strict `token_x`/`token_y` filters if it yields nothing.
   */
  async getPoolsByMint(mint: string): Promise<MeteoraPoolLink[]> {
    const m = mint.trim();
    if (m === '') return [];

    let rows = await this.queryPools({ query: m, filter_by: 'is_blacklisted=false' });
    let matched = rows.filter((p) => matchesMint(p, m));

    if (matched.length === 0) {
      // Strict fallback: query each side and merge.
      const [x, y] = await Promise.all([
        this.queryPools({ filter_by: `token_x=${m}` }),
        this.queryPools({ filter_by: `token_y=${m}` }),
      ]);
      const byAddr = new Map<string, MeteoraPoolRow>();
      for (const p of [...x, ...y]) {
        if (p.address && matchesMint(p, m)) byAddr.set(p.address, p);
      }
      matched = [...byAddr.values()];
    }

    return matched
      .map((p) => toLink(p, m))
      .filter((p): p is MeteoraPoolLink => p !== null)
      .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
      .slice(0, this.maxPools);
  }

  /** GET /pools with the given params, returning the `data` array (empty on error). */
  private async queryPools(params: Record<string, string>): Promise<MeteoraPoolRow[]> {
    const qs = new URLSearchParams({
      page: '1',
      page_size: '1000',
      sort_by: 'tvl:desc',
      ...params,
    });
    const url = `${this.baseUrl}/pools?${qs.toString()}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (res.ok) {
          const json = (await res.json()) as { data?: unknown };
          return Array.isArray(json.data) ? (json.data as MeteoraPoolRow[]) : [];
        }
        // Retry throttle/server errors only; other 4xx are not worth retrying.
        if (res.status !== 429 && res.status < 500) return [];
        lastErr = new Error(`Meteora /pools responded ${res.status}`);
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.attempts - 1) await this.sleep(this.backoffMs * 2 ** attempt);
    }
    if (lastErr) throw lastErr instanceof Error ? lastErr : new Error('Meteora /pools failed');
    return [];
  }
}

function matchesMint(p: MeteoraPoolRow, mint: string): boolean {
  return p.token_x?.address === mint || p.token_y?.address === mint;
}

function shortAddr(a: string): string {
  return a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function toLink(p: MeteoraPoolRow, mint: string): MeteoraPoolLink | null {
  if (!p.address) return null;
  // The quote side is whichever side ISN'T the token we looked up; its symbol is
  // usually reliable (SOL/USDC) even when Meteora omits the base token's symbol.
  const quoteSide = p.token_x?.address === mint ? p.token_y : p.token_x;
  const quoteSymbol =
    quoteSide?.symbol || (quoteSide?.address ? shortAddr(quoteSide.address) : undefined);
  return {
    poolAddress: p.address,
    quoteSymbol,
    volume24h: toNum(p.volume?.['24h']),
    tvl: toNum(p.tvl),
    binStep: toNum(p.pool_config?.bin_step),
    baseFeePct: toNum(p.pool_config?.base_fee_pct),
    url: meteoraPoolUrl(p.address),
  };
}
