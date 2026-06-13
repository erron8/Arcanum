import { test, expect, describe } from 'bun:test';
import { MeteoraClient, meteoraPoolUrl } from '../src/meteora/client';
import type { MeteoraFetch, MeteoraFetchResponse } from '../src/meteora/client';

const MINT = 'So11111111111111111111111111111111111111112';

function res(body: unknown, status = 200): MeteoraFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function pool(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: 'POOL1',
    name: 'SOL-WIF',
    token_x: { address: MINT, symbol: 'SOL' },
    token_y: { address: 'WIFmint', symbol: 'WIF' },
    tvl: 100000,
    volume: { '24h': 50000 },
    pool_config: { bin_step: 80, base_fee_pct: 0.8 },
    ...over,
  };
}

/** A fetch stub that records URLs and returns canned bodies per call index. */
function stub(bodies: MeteoraFetchResponse[]): { fetch: MeteoraFetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetch: MeteoraFetch = async (url) => {
    urls.push(url);
    return bodies[Math.min(i++, bodies.length - 1)]!;
  };
  return { fetch, urls };
}

const noSleep = async (): Promise<void> => {};

function client(fetch: MeteoraFetch): MeteoraClient {
  return new MeteoraClient(
    { baseUrl: 'https://meteora.test', maxPools: 3 },
    { fetch, sleep: noSleep },
  );
}

describe('MeteoraClient.getPoolsByMint', () => {
  test('builds the broad query with the blacklist filter + TVL sort', async () => {
    const { fetch, urls } = stub([res({ data: [pool()] })]);
    await client(fetch).getPoolsByMint(MINT);
    expect(urls[0]).toContain('/pools?');
    expect(urls[0]).toContain(`query=${MINT}`);
    expect(urls[0]).toContain('is_blacklisted%3Dfalse'); // filter_by=is_blacklisted=false (encoded)
    expect(urls[0]).toContain('sort_by=tvl%3Adesc');
  });

  test('keeps only pools where the mint is token_x or token_y', async () => {
    const data = [
      pool({ address: 'A', token_x: { address: MINT, symbol: 'SOL' } }),
      pool({ address: 'B', token_x: { address: 'other' }, token_y: { address: 'nope' } }),
      pool({ address: 'C', token_y: { address: MINT, symbol: 'SOL' } }),
    ];
    const { fetch } = stub([res({ data })]);
    const pools = await client(fetch).getPoolsByMint(MINT);
    expect(pools.map((p) => p.poolAddress).sort()).toEqual(['A', 'C']);
  });

  test('sorts by TVL desc and caps at maxPools', async () => {
    const data = [
      pool({ address: 'A', tvl: 10 }),
      pool({ address: 'B', tvl: 900 }),
      pool({ address: 'C', tvl: 500 }),
      pool({ address: 'D', tvl: 999 }),
    ];
    const { fetch } = stub([res({ data })]);
    const pools = await client(fetch).getPoolsByMint(MINT);
    expect(pools.length).toBe(3); // capped (test client maxPools=3)
    expect(pools.map((p) => p.poolAddress)).toEqual(['D', 'B', 'C']);
  });

  test('maps quote symbol, url, metrics and pool config (bin step + base fee)', async () => {
    const { fetch } = stub([
      res({ data: [pool({ address: 'POOLX', pool_config: { bin_step: 4, base_fee_pct: 0.04 } })] }),
    ]);
    const [p] = await client(fetch).getPoolsByMint(MINT);
    // MINT is token_x here, so the quote side is token_y (WIF).
    expect(p!.quoteSymbol).toBe('WIF');
    expect(p!.url).toBe(meteoraPoolUrl('POOLX'));
    expect(p!.volume24h).toBe(50000);
    expect(p!.tvl).toBe(100000);
    expect(p!.binStep).toBe(4);
    expect(p!.baseFeePct).toBe(0.04);
  });

  test('uses the non-mint side as the quote, even when the base symbol is missing', async () => {
    // DBC-style: our token (token_x = MINT) has no symbol; quote (token_y) is USDC.
    const { fetch } = stub([
      res({
        data: [
          pool({
            address: 'POOLY',
            token_x: { address: MINT, symbol: '' },
            token_y: { address: 'usdcMint', symbol: 'USDC' },
          }),
        ],
      }),
    ]);
    const [p] = await client(fetch).getPoolsByMint(MINT);
    expect(p!.quoteSymbol).toBe('USDC');
  });

  test('falls back to strict token_x/token_y search when broad search has no match', async () => {
    const { fetch, urls } = stub([
      res({ data: [pool({ address: 'Z', token_x: { address: 'x' }, token_y: { address: 'y' } })] }), // broad: no match
      res({ data: [pool({ address: 'A' })] }), // token_x=MINT
      res({ data: [pool({ address: 'A' }), pool({ address: 'C', token_y: { address: MINT } })] }), // token_y=MINT
    ]);
    const pools = await client(fetch).getPoolsByMint(MINT);
    expect(urls.length).toBe(3);
    expect(urls[1]).toContain(`token_x%3D${MINT}`);
    expect(urls[2]).toContain(`token_y%3D${MINT}`);
    // Deduped by address (A appears twice).
    expect(pools.map((p) => p.poolAddress).sort()).toEqual(['A', 'C']);
  });

  test('returns [] for a blank mint without calling the API', async () => {
    const { fetch, urls } = stub([res({ data: [] })]);
    expect(await client(fetch).getPoolsByMint('   ')).toEqual([]);
    expect(urls.length).toBe(0);
  });

  test('a non-retryable 4xx yields [] (no throw)', async () => {
    const { fetch } = stub([res({ error: 'bad' }, 400)]);
    expect(await client(fetch).getPoolsByMint(MINT)).toEqual([]);
  });

  test('a persistent 5xx throws after retries (caller treats as no links)', async () => {
    const { fetch, urls } = stub([res({}, 500)]);
    await expect(client(fetch).getPoolsByMint(MINT)).rejects.toThrow('500');
    expect(urls.length).toBe(3); // attempts
  });
});
