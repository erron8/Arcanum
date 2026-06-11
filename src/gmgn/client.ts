import type {
  GmgnKlineCandle,
  GmgnRankItem,
  GmgnRankParams,
  GmgnTokenInfo,
  GmgnTokenSecurity,
  GmgnWalletEntry,
} from './types';

/** Minimal response shape the client needs; the global `fetch` Response satisfies it. */
export interface GmgnFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface GmgnRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Injectable fetch seam so the client is unit-testable without network access. */
export type GmgnFetch = (url: string, init: GmgnRequestInit) => Promise<GmgnFetchResponse>;

const defaultFetch: GmgnFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<GmgnFetchResponse>;

export interface GmgnClientDeps {
  fetch?: GmgnFetch;
  /** Returns a fresh UUID per request (default: crypto.randomUUID). */
  uuid?: () => string;
  /** Current time in epoch ms (default: Date.now). */
  now?: () => number;
  /** Sleep used between retries (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export interface GmgnClientOptions {
  baseUrl: string;
  apiKey: string;
  attempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Non-retryable failure (e.g. a 4xx other than 429); aborts the retry loop. */
class GmgnNonRetryableError extends Error {}

/** Coerce a string-or-number GMGN field to a finite number, or undefined. */
export function toNum(x: unknown): number | undefined {
  if (typeof x === 'number') return Number.isFinite(x) ? x : undefined;
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Build a sorted, GMGN-style query string. Array params are emitted as repeated
 * `k=v` pairs. `timestamp` and `client_id` are always included so every request
 * carries fresh auth params. Exported for white-box testing of the query builder.
 */
export function buildQueryString(
  params: Record<string, string | number | string[] | undefined>,
  auth: { timestamp: number; clientId: string },
): string {
  const pairs: Array<[string, string]> = [];
  const add = (k: string, v: string | number): void => {
    pairs.push([k, String(v)]);
  };

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) add(k, item);
    } else {
      add(k, v);
    }
  }
  add('timestamp', auth.timestamp);
  add('client_id', auth.clientId);

  return pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * Unwrap a GMGN response envelope. Responses nest the useful payload under one
 * or two `data` layers (e.g. `data.data.rank`, `data.list`); peel up to two so
 * callers can read the inner object directly.
 */
function envelopeData(json: unknown): Record<string, unknown> {
  let cur: unknown = json;
  for (let i = 0; i < 2; i++) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && 'data' in cur) {
      cur = (cur as Record<string, unknown>).data;
    } else {
      break;
    }
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : {};
}

function asArray<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

/**
 * GMGN OpenAPI client (read endpoints only).
 *
 * Every request carries `X-APIKEY`, a fresh `timestamp` (Unix seconds) and a
 * fresh random `client_id` (UUID). Transient failures (429, 5xx, network, abort)
 * are retried with exponential backoff. The API key is never logged.
 */
export class GmgnClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: GmgnFetch;
  private readonly uuid: () => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: GmgnClientOptions, deps: GmgnClientDeps = {}) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.attempts = Math.max(1, opts.attempts ?? 3);
    this.backoffMs = Math.max(0, opts.backoffMs ?? 500);
    this.timeoutMs = Math.max(1, opts.timeoutMs ?? 8_000);
    this.fetchImpl = deps.fetch ?? defaultFetch;
    this.uuid = deps.uuid ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? realSleep;
  }

  /**
   * Build the URL + request init for a path, including auth query params and the
   * API-key header. Exposed for white-box tests of the auth/query builder.
   */
  buildRequest(
    path: string,
    opts: {
      params?: Record<string, string | number | string[] | undefined>;
      method?: string;
      body?: unknown;
    } = {},
  ): { url: string; init: GmgnRequestInit } {
    const timestamp = Math.floor(this.now() / 1000);
    const clientId = this.uuid();
    const query = buildQueryString(opts.params ?? {}, { timestamp, clientId });
    const url = `${this.baseUrl}${path}?${query}`;
    const init: GmgnRequestInit = {
      method: opts.method ?? 'GET',
      headers: {
        'X-APIKEY': this.apiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return { url, init };
  }

  /** Issue a request with timeout + retry/backoff, returning the parsed JSON. */
  private async request(
    path: string,
    opts: {
      params?: Record<string, string | number | string[] | undefined>;
      method?: string;
      body?: unknown;
    } = {},
  ): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      // Fresh timestamp + client_id per attempt (the server rejects ±5s drift / replays).
      const { url, init } = this.buildRequest(path, opts);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
        if (res.ok) {
          return await res.json();
        }
        // Retry transient server/throttle statuses; fail fast on 4xx (except 429).
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`GMGN ${path} responded ${res.status}`);
        } else {
          throw new GmgnNonRetryableError(`GMGN ${path} responded ${res.status}`);
        }
      } catch (err) {
        // A non-retryable status aborts immediately rather than being retried.
        if (err instanceof GmgnNonRetryableError) throw err;
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.attempts - 1) await this.sleep(this.backoffMs * 2 ** attempt);
    }
    throw lastErr instanceof Error ? lastErr : new Error(`GMGN ${path} failed`);
  }

  // --- endpoints -----------------------------------------------------------

  /** `GET /v1/market/rank` → trending tokens. */
  async getRank(params: GmgnRankParams): Promise<GmgnRankItem[]> {
    const json = await this.request('/v1/market/rank', {
      params: {
        chain: params.chain,
        interval: params.interval,
        order_by: params.order_by,
        direction: params.direction,
        limit: params.limit,
        filters: params.filters,
        platforms: params.platforms,
      },
    });
    return asArray<GmgnRankItem>(envelopeData(json).rank);
  }

  /** `GET /v1/token/info` → token detail (price, mcap, fees, age). */
  async getTokenInfo(chain: string, address: string): Promise<GmgnTokenInfo | null> {
    const json = await this.request('/v1/token/info', { params: { chain, address } });
    const data = envelopeData(json);
    return Object.keys(data).length > 0 ? (data as GmgnTokenInfo) : null;
  }

  /** `GET /v1/token/security` → contract/holder safety. */
  async getTokenSecurity(chain: string, address: string): Promise<GmgnTokenSecurity | null> {
    const json = await this.request('/v1/token/security', { params: { chain, address } });
    const data = envelopeData(json);
    return Object.keys(data).length > 0 ? (data as GmgnTokenSecurity) : null;
  }

  /** `GET /v1/market/token_top_holders`. */
  async getTopHolders(
    chain: string,
    address: string,
    limit = 100,
  ): Promise<GmgnWalletEntry[]> {
    const json = await this.request('/v1/market/token_top_holders', {
      params: { chain, address, limit, order_by: 'amount_percentage', direction: 'desc' },
    });
    return asArray<GmgnWalletEntry>(envelopeData(json).list);
  }

  /** `GET /v1/market/token_top_traders`. */
  async getTopTraders(
    chain: string,
    address: string,
    limit = 100,
  ): Promise<GmgnWalletEntry[]> {
    const json = await this.request('/v1/market/token_top_traders', {
      params: { chain, address, limit, order_by: 'buy_volume_cur', direction: 'desc' },
    });
    return asArray<GmgnWalletEntry>(envelopeData(json).list);
  }

  /** `GET /v1/market/token_kline` → OHLCV candles for the given window. */
  async getKline(
    chain: string,
    address: string,
    resolution: string,
    from: number,
    to: number,
  ): Promise<GmgnKlineCandle[]> {
    const json = await this.request('/v1/market/token_kline', {
      params: { chain, address, resolution, from, to },
    });
    return asArray<GmgnKlineCandle>(envelopeData(json).list);
  }
}
