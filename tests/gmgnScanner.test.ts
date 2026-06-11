import { test, expect, describe } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GmgnClient } from '../src/gmgn/client';
import type { GmgnFetch, GmgnFetchResponse } from '../src/gmgn/client';
import { GmgnScreenedStore } from '../src/gmgn/store';
import { AlertStore } from '../src/alerts/store';
import {
  GmgnScanner,
  quickFilterRank,
  baseFilter,
  athFromKline,
  screenSecurity,
  extractSmartMoney,
  analyzeVolume,
} from '../src/gmgn/scanner';
import { buildConfig } from '../src/alerts/config';
import type { GmgnConfig } from '../src/alerts/config';
import type { GmgnTokenInfo, GmgnWalletEntry } from '../src/gmgn/types';

const gcfg = (over: Partial<GmgnConfig> = {}): GmgnConfig => ({ ...buildConfig({}).gmgn, ...over });

// --- pure: quick filter ----------------------------------------------------
describe('quickFilterRank', () => {
  const cfg = { marketCapMinUsd: 250_000 };
  test('drops below-mcap, wash, bundler-heavy, no-smart-money', () => {
    expect(quickFilterRank({ address: 'a', market_cap: 100_000 }, cfg)).toBe(false);
    expect(quickFilterRank({ address: 'a', is_wash_trading: true }, cfg)).toBe(false);
    expect(quickFilterRank({ address: 'a', bundler_rate: 0.5 }, cfg)).toBe(false);
    expect(quickFilterRank({ address: 'a', smart_degen_count: 0 }, cfg)).toBe(false);
    expect(quickFilterRank({ market_cap: 1e9 }, cfg)).toBe(false); // no address
  });
  test('keeps a candidate that clears every present field', () => {
    expect(
      quickFilterRank(
        { address: 'a', market_cap: 1_000_000, bundler_rate: 0.1, smart_degen_count: 3 },
        cfg,
      ),
    ).toBe(true);
  });
  test('missing optional fields never drop a candidate', () => {
    expect(quickFilterRank({ address: 'a' }, cfg)).toBe(true);
  });
});

// --- pure: base filter -----------------------------------------------------
describe('baseFilter', () => {
  const cfg = {
    totalFeeMinSol: 30,
    marketCapMinUsd: 250_000,
    drawdownMinPct: 50,
    minTokenAgeHours: 4,
    maxTokenAgeDays: 14,
  };
  const NOW = 1_700_000_000_000;
  const HOUR = 3_600_000;
  // Opened 2 days ago → within [4h, 14d].
  const openedAt = Math.floor((NOW - 48 * HOUR) / 1000);

  const passing: GmgnTokenInfo = {
    total_fee: 50,
    market_cap: 500_000,
    price: 0.4,
    ath_price: 1.0, // 60% down
    open_timestamp: openedAt,
  };

  test('passes when every criterion clears', () => {
    const r = baseFilter(passing, cfg, { nowMs: NOW });
    expect(r.pass).toBe(true);
    expect(Math.round(r.drawdownPct)).toBe(60);
    expect(r.totalFeeSol).toBe(50);
    expect(r.marketCap).toBe(500_000);
  });

  test('fails on low total_fee', () => {
    expect(baseFilter({ ...passing, total_fee: 10 }, cfg, { nowMs: NOW }).pass).toBe(false);
  });

  test('fails on low market cap', () => {
    expect(baseFilter({ ...passing, market_cap: 100_000 }, cfg, { nowMs: NOW }).pass).toBe(false);
  });

  test('derives market cap from price × circulating_supply when absent', () => {
    const r = baseFilter(
      { ...passing, market_cap: undefined, price: 0.4, circulating_supply: 2_000_000 },
      cfg,
      { nowMs: NOW },
    );
    expect(r.marketCap).toBe(800_000);
    expect(r.pass).toBe(true);
  });

  test('fails when too young or too old', () => {
    const young = Math.floor((NOW - 1 * HOUR) / 1000);
    const old = Math.floor((NOW - 30 * 24 * HOUR) / 1000);
    expect(baseFilter({ ...passing, open_timestamp: young }, cfg, { nowMs: NOW }).pass).toBe(false);
    expect(baseFilter({ ...passing, open_timestamp: old }, cfg, { nowMs: NOW }).pass).toBe(false);
  });

  test('uses creation_timestamp when open_timestamp absent', () => {
    const r = baseFilter(
      { ...passing, open_timestamp: undefined, creation_timestamp: openedAt },
      cfg,
      { nowMs: NOW },
    );
    expect(r.pass).toBe(true);
  });

  test('fails on insufficient drawdown', () => {
    // price 0.8 vs ath 1.0 → only 20% down.
    expect(baseFilter({ ...passing, price: 0.8 }, cfg, { nowMs: NOW }).pass).toBe(false);
  });

  test('falls back to kline ATH when ath_price missing', () => {
    const r = baseFilter({ ...passing, ath_price: undefined }, cfg, {
      nowMs: NOW,
      klineAth: 1.0,
    });
    expect(Math.round(r.drawdownPct)).toBe(60);
    expect(r.pass).toBe(true);
  });

  test('fails when no ATH available at all', () => {
    const r = baseFilter({ ...passing, ath_price: undefined }, cfg, { nowMs: NOW });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('ATH'))).toBe(true);
  });
});

describe('athFromKline', () => {
  test('returns the max high (coercing strings)', () => {
    expect(athFromKline([{ high: '1.2' }, { high: 3 }, { high: '2.5' }])).toBe(3);
    expect(athFromKline([])).toBe(0);
  });
});

// --- pure: security --------------------------------------------------------
describe('screenSecurity', () => {
  test('hard-fails on each blocking condition', () => {
    expect(screenSecurity({ renounced_mint: 0 }).hardFails.length).toBeGreaterThan(0);
    expect(screenSecurity({ renounced_freeze_account: false }).hardFails.length).toBeGreaterThan(0);
    expect(screenSecurity({ is_wash_trading: true }).hardFails.length).toBeGreaterThan(0);
    expect(screenSecurity({ rug_ratio: 0.5 }).hardFails.length).toBeGreaterThan(0);
    expect(screenSecurity({ top_10_holder_rate: 0.6 }).hardFails.length).toBeGreaterThan(0);
    expect(screenSecurity({ creator_token_status: 'creator_hold' }).hardFails.length).toBeGreaterThan(0);
    expect(screenSecurity({ sniper_count: 25 }).hardFails.length).toBeGreaterThan(0);
    expect(screenSecurity({ bundler_trader_amount_rate: 0.5 }).hardFails.length).toBeGreaterThan(0);
  });

  test('warns (does not block) in the middle bands', () => {
    const r = screenSecurity({
      renounced_mint: 1,
      renounced_freeze_account: 1,
      rug_ratio: 0.2,
      top_10_holder_rate: 0.3,
      sniper_count: 10,
      bundler_trader_amount_rate: 0.3,
    });
    expect(r.hardFails).toEqual([]);
    expect(r.warnings.length).toBe(4);
  });

  test('clean token has no fails or warnings', () => {
    const r = screenSecurity({
      renounced_mint: 1,
      renounced_freeze_account: 1,
      rug_ratio: 0.05,
      top_10_holder_rate: 0.1,
      sniper_count: 1,
      bundler_trader_amount_rate: 0.05,
    });
    expect(r.hardFails).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('null security yields a warning (not a silent pass)', () => {
    expect(screenSecurity(null).warnings.length).toBe(1);
    expect(screenSecurity(null).hardFails).toEqual([]);
  });

  test('missing renounce fields fail closed (not a silent pass)', () => {
    // Both renounce fields absent → two hard fails.
    const both = screenSecurity({ rug_ratio: 0.02, top_10_holder_rate: 0.1 });
    expect(both.hardFails.some((f) => f.includes('mint authority'))).toBe(true);
    expect(both.hardFails.some((f) => f.includes('freeze authority'))).toBe(true);

    // Only one present → the other still fails.
    const onlyMint = screenSecurity({ renounced_mint: 1 });
    expect(onlyMint.hardFails.some((f) => f.includes('freeze authority'))).toBe(true);
    expect(onlyMint.hardFails.some((f) => f.includes('mint authority'))).toBe(false);

    // String "yes" counts as confirmed renounced.
    const strings = screenSecurity({ renounced_mint: 'yes', renounced_freeze_account: 'yes' });
    expect(strings.hardFails).toEqual([]);
  });
});

// --- pure: smart money -----------------------------------------------------
describe('extractSmartMoney', () => {
  const holders: GmgnWalletEntry[] = [
    { address: 's1', tags: ['smart_degen'], end_holding_at: null, unrealized_profit: 100, buy_volume_cur: 5000 },
    { address: 's2', tags: ['smart_degen'], end_holding_at: 123, sell_amount_percentage: 0.9 },
    { address: 'k1', tags: ['kol'], end_holding_at: null },
    { address: 'k2', tags: ['kol'], end_holding_at: 99, sell_amount_percentage: 0.95 },
    { address: 'r1', tags: ['fresh_wallet'] }, // neither SM nor KOL
  ];
  test('counts holding/exited/unrealized and top buy volume', () => {
    const sm = extractSmartMoney(holders, []);
    expect(sm.smHolding).toBe(1);
    expect(sm.smExited).toBe(1);
    expect(sm.smUnrealizedPositive).toBe(1);
    expect(sm.kolHolding).toBe(1);
    expect(sm.kolExited).toBe(1);
    expect(sm.topSmBuyVolume).toBe(5000);
  });

  test('merges holder + trader rows for the same wallet without double-counting', () => {
    const sm = extractSmartMoney(
      [{ address: 's1', tags: ['smart_degen'], end_holding_at: null }],
      [{ address: 's1', tags: ['smart_degen'], buy_volume_cur: 9000 }],
    );
    expect(sm.smHolding).toBe(1);
    expect(sm.topSmBuyVolume).toBe(9000);
  });
});

// --- pure: volume authenticity ---------------------------------------------
describe('analyzeVolume', () => {
  test('flags a single spike then dead volume', () => {
    const candles = [
      { volume: 100, close: 1 },
      { volume: 10000, close: 1 },
      { volume: 5, close: 1 },
      { volume: 2, close: 1 },
    ];
    const w = analyzeVolume(candles);
    expect(w.some((x) => x.includes('spike'))).toBe(true);
  });

  test('flags flat price with active volume', () => {
    const candles = Array.from({ length: 6 }, () => ({ volume: 500, close: 1.0 }));
    const w = analyzeVolume(candles);
    expect(w.some((x) => x.includes('flat'))).toBe(true);
  });

  test('flags many near-identical volume candles', () => {
    const candles = [
      { volume: 1000, close: 1 },
      { volume: 1001, close: 1.1 },
      { volume: 1000, close: 1.2 },
      { volume: 1002, close: 1.3 },
      { volume: 999, close: 1.4 },
    ];
    const w = analyzeVolume(candles);
    expect(w.some((x) => x.includes('identical'))).toBe(true);
  });

  test('cross-references security/info flags', () => {
    const w = analyzeVolume([], {
      security: { is_wash_trading: true, bundler_trader_amount_rate: 0.5, rat_trader_amount_rate: 0.3 },
      info: { stat: { bot_degen_rate: 0.5 } },
    });
    expect(w.some((x) => x.includes('is_wash_trading'))).toBe(true);
    expect(w.some((x) => x.includes('bundler'))).toBe(true);
    expect(w.some((x) => x.includes('rat_trader'))).toBe(true);
    expect(w.some((x) => x.includes('bot_degen'))).toBe(true);
  });

  test('organic-looking data yields no warnings', () => {
    const candles = [
      { volume: 100, close: 1.0 },
      { volume: 250, close: 1.3 },
      { volume: 180, close: 1.6 },
      { volume: 300, close: 1.9 },
    ];
    expect(analyzeVolume(candles)).toEqual([]);
  });
});

// --- scanner orchestration -------------------------------------------------

function jsonRes(body: unknown, status = 200): GmgnFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => '' };
}

const NOW = 1_700_000_000_000;
const openedAt = Math.floor((NOW - 48 * 3_600_000) / 1000);

/** Route a GMGN request URL to a canned response body. */
function routerFetch(routes: Array<[string, unknown]>): GmgnFetch {
  return async (url) => {
    for (const [needle, body] of routes) {
      if (url.includes(needle)) return jsonRes(body);
    }
    return jsonRes({ data: {} });
  };
}

const cleanSecurity = {
  renounced_mint: 1,
  renounced_freeze_account: 1,
  rug_ratio: 0.02,
  top_10_holder_rate: 0.1,
  sniper_count: 1,
  bundler_trader_amount_rate: 0.05,
};

const passingInfo = {
  symbol: 'WIF',
  name: 'dogwifhat',
  total_fee: 50,
  market_cap: 500_000,
  price: 0.4,
  ath_price: 1.0,
  open_timestamp: openedAt,
};

const organicKline = {
  list: [
    { volume: '100', close: '1.0', high: '1.0' },
    { volume: '250', close: '1.3', high: '1.4' },
    { volume: '180', close: '0.6', high: '1.5' },
    { volume: '300', close: '0.4', high: '1.0' },
  ],
};

function passingRoutes(): Array<[string, unknown]> {
  return [
    ['/v1/market/rank', { data: { data: { rank: [{ address: 'MINT1', symbol: 'WIF', smart_degen_count: 2, market_cap: 500_000 }] } } }],
    ['/v1/token/info', { data: passingInfo }],
    ['/v1/token/security', { data: cleanSecurity }],
    ['/v1/market/token_top_holders', { data: { list: [{ address: 's1', tags: ['smart_degen'], end_holding_at: null, buy_volume_cur: 1000 }] } }],
    ['/v1/market/token_top_traders', { data: { list: [] } }],
    ['/v1/market/token_kline', { data: organicKline }],
  ];
}

function makeClient(routes: Array<[string, unknown]>): GmgnClient {
  return new GmgnClient(
    { baseUrl: 'https://x', apiKey: 'k', attempts: 1, backoffMs: 0 },
    { fetch: routerFetch(routes), uuid: () => 'u', now: () => NOW, sleep: async () => {} },
  );
}

/** Like makeClient but records every requested URL into `urls`. */
function makeCapturingClient(routes: Array<[string, unknown]>, urls: string[]): GmgnClient {
  const router = routerFetch(routes);
  return new GmgnClient(
    { baseUrl: 'https://x', apiKey: 'k', attempts: 1, backoffMs: 0 },
    {
      fetch: async (url, init) => {
        urls.push(url);
        return router(url, init);
      },
      uuid: () => 'u',
      now: () => NOW,
      sleep: async () => {},
    },
  );
}

async function newScreenedStore(): Promise<GmgnScreenedStore> {
  const path = join(tmpdir(), `gss-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const s = new GmgnScreenedStore(path, { writer: async () => {}, now: () => NOW });
  await s.init();
  return s;
}

describe('GmgnScanner.scanOnce', () => {
  test('PASS candidate is screened, alerted, and recorded', async () => {
    const store = await newScreenedStore();
    const sent: string[][] = [];
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(passingRoutes()),
      store,
      notify: async (msgs) => {
        sent.push(msgs);
        return true;
      },
      now: () => NOW,
    });
    const results = await scanner.scanOnce();
    expect(results.length).toBe(1);
    expect(results[0]!.verdict).toBe('PASS');
    expect(results[0]!.symbol).toBe('WIF');
    expect(Math.round(results[0]!.drawdownPct)).toBe(60);
    expect(sent.length).toBe(1);
    expect(sent[0]![0]).toContain('GMGN Screening');
    expect(store.wasRecentlyAlerted('MINT1', gcfg().dedupeMs)).toBe(true);
  });

  test('hard-fail candidate is blocked (no alert)', async () => {
    const routes = passingRoutes();
    // Replace security with a rug.
    routes[2] = ['/v1/token/security', { data: { ...cleanSecurity, rug_ratio: 0.9 } }];
    const store = await newScreenedStore();
    let notified = false;
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(routes),
      store,
      notify: async () => {
        notified = true;
        return true;
      },
      now: () => NOW,
    });
    const results = await scanner.scanOnce();
    expect(results.length).toBe(1);
    expect(results[0]!.verdict).toBe('FAIL');
    expect(notified).toBe(false); // blocked
    expect(store.wasRecentlyAlerted('MINT1', gcfg().dedupeMs)).toBe(false);
  });

  test('base-filter failures never reach screening or alerts', async () => {
    const routes = passingRoutes();
    routes[1] = ['/v1/token/info', { data: { ...passingInfo, total_fee: 1 } }]; // fails base
    const store = await newScreenedStore();
    let notified = false;
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(routes),
      store,
      notify: async () => {
        notified = true;
        return true;
      },
      now: () => NOW,
    });
    expect((await scanner.scanOnce()).length).toBe(0);
    expect(notified).toBe(false);
  });

  test('dedupe blocks re-alerting within the window', async () => {
    const store = await newScreenedStore();
    await store.record('MINT1', 'WIF', gcfg().dedupeMs); // already alerted
    let notified = false;
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(passingRoutes()),
      store,
      notify: async () => {
        notified = true;
        return true;
      },
      now: () => NOW,
    });
    const results = await scanner.scanOnce();
    expect(results.length).toBe(1); // still screened…
    expect(notified).toBe(false); // …but not re-alerted
  });

  test('undelivered batch is not recorded (will retry next cycle)', async () => {
    const store = await newScreenedStore();
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(passingRoutes()),
      store,
      notify: async () => false, // no subscribers / delivery failed
      now: () => NOW,
    });
    await scanner.scanOnce();
    expect(store.wasRecentlyAlerted('MINT1', gcfg().dedupeMs)).toBe(false);
  });

  test('GMGN_AUTO_WATCH adds the passing mint to the AlertStore at threshold 50', async () => {
    const store = await newScreenedStore();
    const watch = new AlertStore(
      join(tmpdir(), `aw-${Date.now()}.json`),
      { flushDelayMs: 9999, writer: async () => {} },
    );
    await watch.init();
    const scanner = new GmgnScanner(gcfg({ autoWatch: true }), {
      client: makeClient(passingRoutes()),
      store,
      notify: async () => true,
      watchStore: watch,
      now: () => NOW,
    });
    await scanner.scanOnce();
    expect(watch.has('MINT1')).toBe(true);
    expect(watch.get('MINT1')!.threshold).toBe(50);
  });

  test('a single token failure does not abort the cycle', async () => {
    // Two candidates; token/info throws for the bad one (404), succeeds for the good one.
    const routes: Array<[string, unknown]> = [
      ['/v1/market/rank', { data: { data: { rank: [{ address: 'GOOD', smart_degen_count: 1, market_cap: 500_000 }, { address: 'BAD', smart_degen_count: 1, market_cap: 500_000 }] } } }],
      ['/v1/token/security', { data: cleanSecurity }],
      ['/v1/market/token_top_holders', { data: { list: [] } }],
      ['/v1/market/token_top_traders', { data: { list: [] } }],
      ['/v1/market/token_kline', { data: organicKline }],
    ];
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k', attempts: 1, backoffMs: 0 },
      {
        fetch: async (url) => {
          if (url.includes('/v1/token/info')) {
            if (url.includes('address=BAD')) return jsonRes({}, 500);
            return jsonRes({ data: passingInfo });
          }
          for (const [needle, body] of routes) if (url.includes(needle)) return jsonRes(body);
          return jsonRes({ data: {} });
        },
        uuid: () => 'u',
        now: () => NOW,
        sleep: async () => {},
      },
    );
    const store = await newScreenedStore();
    const scanner = new GmgnScanner(gcfg(), {
      client,
      store,
      notify: async () => true,
      now: () => NOW,
    });
    const results = await scanner.scanOnce();
    expect(results.length).toBe(1);
    expect(results[0]!.mint).toBe('GOOD');
  });
});

describe('GmgnScanner overlap guard', () => {
  test('a second cycle is skipped while the first is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // getRank blocks until we release the gate.
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k', attempts: 1, backoffMs: 0 },
      {
        fetch: async () => {
          await gate;
          return jsonRes({ data: { data: { rank: [] } } });
        },
        uuid: () => 'u',
        now: () => NOW,
        sleep: async () => {},
      },
    );
    const store = await newScreenedStore();
    const scanner = new GmgnScanner(gcfg(), { client, store, notify: async () => true });

    const first = scanner.runCycle(); // starts, blocks on gate
    await new Promise((r) => setTimeout(r, 5));
    expect(scanner.isScanning()).toBe(true);
    const second = await scanner.runCycle(); // skipped immediately
    expect(second).toBeNull();

    release();
    await first;
    expect(scanner.isScanning()).toBe(false);
  });
});

describe('GmgnScanner ATH fallback', () => {
  test('uses full-lifetime hourly kline (not the recent window) when ath_price missing', async () => {
    const routes = passingRoutes();
    routes[1] = ['/v1/token/info', { data: { ...passingInfo, ath_price: undefined } }];
    const urls: string[] = [];
    const store = await newScreenedStore();
    const scanner = new GmgnScanner(gcfg(), {
      client: makeCapturingClient(routes, urls),
      store,
      notify: async () => true,
      now: () => NOW,
    });
    const results = await scanner.scanOnce();
    expect(results.length).toBe(1);
    // organicKline max high = 1.5; price 0.4 → ~73% down.
    expect(results[0]!.athPrice).toBe(1.5);
    expect(results[0]!.drawdownPct).toBeGreaterThan(50);
    // The ATH fallback must request hourly candles, not only the 5m recent window.
    expect(urls.some((u) => u.includes('token_kline') && u.includes('resolution=1h'))).toBe(true);
  });

  test('fails closed when no ATH can be established (empty kline)', async () => {
    const routes = passingRoutes();
    routes[1] = ['/v1/token/info', { data: { ...passingInfo, ath_price: undefined } }];
    routes[5] = ['/v1/market/token_kline', { data: { list: [] } }];
    const store = await newScreenedStore();
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(routes),
      store,
      notify: async () => true,
      now: () => NOW,
    });
    expect((await scanner.scanOnce()).length).toBe(0);
  });
});

describe('GmgnScanner smart-money enforcement', () => {
  test('warns when no smart money is present', async () => {
    const routes = passingRoutes();
    routes[3] = ['/v1/market/token_top_holders', { data: { list: [] } }];
    routes[4] = ['/v1/market/token_top_traders', { data: { list: [] } }];
    const store = await newScreenedStore();
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(routes),
      store,
      notify: async () => true,
      now: () => NOW,
    });
    const r = await scanner.scanOnce();
    expect(r[0]!.verdict).toBe('WARN');
    expect(r[0]!.warnings.some((w) => w.includes('no smart money'))).toBe(true);
  });
});

describe('GmgnScanner resilience', () => {
  test('a dedupe write failure does not crash the cycle and still alerts', async () => {
    const failing = new GmgnScreenedStore(join(tmpdir(), `fail-${Date.now()}.json`), {
      writer: async () => {
        throw new Error('disk full');
      },
      now: () => NOW,
    });
    await failing.init();
    let notified = false;
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(passingRoutes()),
      store: failing,
      notify: async () => {
        notified = true;
        return true;
      },
      now: () => NOW,
    });
    const r = await scanner.scanOnce();
    expect(notified).toBe(true);
    expect(r.length).toBe(1);
  });
});

describe('GmgnScanner shutdown', () => {
  test('does not start a cycle or notify once stopped', async () => {
    const store = await newScreenedStore();
    let notified = false;
    const scanner = new GmgnScanner(gcfg(), {
      client: makeClient(passingRoutes()),
      store,
      notify: async () => {
        notified = true;
        return true;
      },
      now: () => NOW,
    });
    await scanner.stop();
    expect(await scanner.runCycle()).toBeNull();
    expect(notified).toBe(false);
  });

  test('stop() awaits the in-flight cycle before resolving', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const client = new GmgnClient(
      { baseUrl: 'https://x', apiKey: 'k', attempts: 1, backoffMs: 0 },
      {
        fetch: async (url) => {
          if (url.includes('/v1/market/rank')) await gate;
          return jsonRes({ data: { data: { rank: [] } } });
        },
        uuid: () => 'u',
        now: () => NOW,
        sleep: async () => {},
      },
    );
    const store = await newScreenedStore();
    const scanner = new GmgnScanner(gcfg(), { client, store, notify: async () => true });

    const cycle = scanner.runCycle();
    await new Promise((r) => setTimeout(r, 5));
    let stopResolved = false;
    const stopP = scanner.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(stopResolved).toBe(false); // still awaiting the gated cycle

    release();
    await stopP;
    await cycle;
    expect(stopResolved).toBe(true);
    expect(scanner.isScanning()).toBe(false);
  });
});
