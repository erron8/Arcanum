import { test, expect, describe } from 'bun:test';
import { GmgnClient, buildQueryString, toNum } from '../src/gmgn/client';
import type { GmgnFetch, GmgnFetchResponse } from '../src/gmgn/client';

function jsonRes(body: unknown, status = 200): GmgnFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function jsonResWithRetryAfter(body: unknown, status: number, retryAfter: string): GmgnFetchResponse {
  return {
    ...jsonRes(body, status),
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
  };
}

const deps = (fetchImpl: GmgnFetch) => ({
  fetch: fetchImpl,
  uuid: () => 'fixed-uuid-1234',
  now: () => 1_700_000_000_000, // fixed epoch ms → 1_700_000_000 s
  sleep: async () => {},
});

describe('buildQueryString', () => {
  test('always appends timestamp and client_id', () => {
    const q = buildQueryString(
      { chain: 'sol', limit: 100 },
      { timestamp: 1700, clientId: 'abc' },
    );
    expect(q).toContain('chain=sol');
    expect(q).toContain('limit=100');
    expect(q).toContain('timestamp=1700');
    expect(q).toContain('client_id=abc');
  });

  test('emits array params as repeated k=v pairs and skips undefined', () => {
    const q = buildQueryString(
      { filters: ['renounced', 'frozen'], order_by: undefined },
      { timestamp: 1, clientId: 'x' },
    );
    expect(q).toContain('filters=renounced');
    expect(q).toContain('filters=frozen');
    expect(q).not.toContain('order_by');
  });
});

describe('GmgnClient auth', () => {
  test('request carries X-APIKEY header + fresh timestamp/client_id', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const client = new GmgnClient(
      { baseUrl: 'https://openapi.gmgn.ai', apiKey: 'secret-key' },
      deps(async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers;
        return jsonRes({ data: { data: { rank: [] } } });
      }),
    );
    await client.getRank({ chain: 'sol', interval: '5m', limit: 100 });

    expect(seenHeaders['X-APIKEY']).toBe('secret-key');
    expect(seenUrl).toContain('timestamp=1700000000'); // ms→s
    expect(seenUrl).toContain('client_id=fixed-uuid-1234');
    expect(seenUrl).toContain('/v1/market/rank');
  });

  test('buildRequest does not leak the key into the URL', () => {
    const client = new GmgnClient(
      { baseUrl: 'https://openapi.gmgn.ai', apiKey: 'secret-key' },
      deps(async () => jsonRes({})),
    );
    const { url, init } = client.buildRequest('/v1/token/info', {
      params: { chain: 'sol', address: 'MINT' },
    });
    expect(url).not.toContain('secret-key');
    expect(init.headers['X-APIKEY']).toBe('secret-key');
  });
});

describe('GmgnClient retries', () => {
  test('retries 5xx then succeeds', async () => {
    let calls = 0;
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k', attempts: 3, backoffMs: 0 },
      deps(async () => {
        calls++;
        return calls < 3 ? jsonRes({}, 500) : jsonRes({ data: { data: { rank: [{ address: 'a' }] } } });
      }),
    );
    const rank = await client.getRank({ chain: 'sol' });
    expect(calls).toBe(3);
    expect(rank.length).toBe(1);
  });

  test('does not retry a 4xx (other than 429) and throws', async () => {
    let calls = 0;
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k', attempts: 3, backoffMs: 0 },
      deps(async () => {
        calls++;
        return jsonRes({}, 400);
      }),
    );
    await expect(client.getTokenInfo('sol', 'MINT')).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test('retries on network error', async () => {
    let calls = 0;
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k', attempts: 2, backoffMs: 0 },
      deps(async () => {
        calls++;
        if (calls === 1) throw new Error('network down');
        return jsonRes({ data: { list: [{ address: 'h' }] } });
      }),
    );
    const holders = await client.getTopHolders('sol', 'MINT');
    expect(calls).toBe(2);
    expect(holders.length).toBe(1);
  });

  test('paces sequential requests through the client-wide throttle', async () => {
    let now = 1_700_000_000_000;
    const waits: number[] = [];
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k', minIntervalMs: 100, attempts: 1 },
      {
        fetch: async () => jsonRes({ data: { symbol: 'WIF' } }),
        uuid: () => 'u',
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      },
    );
    await client.getTokenInfo('sol', 'MINT1');
    await client.getTokenInfo('sol', 'MINT2');
    expect(waits).toContain(100);
  });

  test('honors Retry-After after a 429 before retrying', async () => {
    let calls = 0;
    let now = 1_700_000_000_000;
    const waits: number[] = [];
    const client = new GmgnClient(
      {
        baseUrl: 'https://x',
        apiKey: 'k',
        attempts: 2,
        backoffMs: 0,
        minIntervalMs: 0,
        rateLimitCooldownMs: 5_000,
      },
      {
        fetch: async () => {
          calls++;
          return calls === 1
            ? jsonResWithRetryAfter({}, 429, '2')
            : jsonRes({ data: { symbol: 'WIF' } });
        },
        uuid: () => 'u',
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      },
    );
    const info = await client.getTokenInfo('sol', 'MINT');
    expect(info?.symbol).toBe('WIF');
    expect(waits).toContain(2_000);
  });
});

describe('GmgnClient envelope extraction', () => {
  test('token info unwraps nested data', async () => {
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k' },
      deps(async () => jsonRes({ data: { symbol: 'WIF', price: '1.5' } })),
    );
    const info = await client.getTokenInfo('sol', 'MINT');
    expect(info?.symbol).toBe('WIF');
  });

  test('kline reads data.list', async () => {
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k' },
      deps(async () => jsonRes({ data: { list: [{ high: '2', volume: '10' }] } })),
    );
    const candles = await client.getKline('sol', 'MINT', '5m', 0, 1);
    expect(candles.length).toBe(1);
    expect(candles[0]!.high).toBe('2');
  });
});

describe('toNum', () => {
  test('coerces strings and numbers, rejects junk', () => {
    expect(toNum('1.5')).toBe(1.5);
    expect(toNum(2)).toBe(2);
    expect(toNum('')).toBeUndefined();
    expect(toNum('abc')).toBeUndefined();
    expect(toNum(undefined)).toBeUndefined();
    expect(toNum(Number.NaN)).toBeUndefined();
  });
});
