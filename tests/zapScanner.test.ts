import { test, expect, describe } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GmgnClient } from '../src/gmgn/client';
import type { GmgnFetch, GmgnFetchResponse } from '../src/gmgn/client';
import { GmgnScreenedStore } from '../src/gmgn/store';
import { AlertStore } from '../src/alerts/store';
import {
  ZapScanner,
  quickFilterZapRank,
  zapBaseFilter,
  max5mVolume,
  partitionZapSecurity,
} from '../src/gmgn/zapScanner';
import { screenSecurity } from '../src/gmgn/scanner';
import { computeSupertrend } from '../src/gmgn/indicators';
import { buildConfig } from '../src/alerts/config';
import type { ZapConfig } from '../src/alerts/config';
import type { GmgnKlineCandle, GmgnTokenInfo } from '../src/gmgn/types';

const zcfg = (over: Partial<ZapConfig> = {}): ZapConfig => ({ ...buildConfig({}).zap, ...over });

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const openedAt = Math.floor((NOW - 18 * HOUR) / 1000); // 18h old → under 2 days

// --- pure: quick filter ----------------------------------------------------
describe('quickFilterZapRank', () => {
  const cfg = { marketCapMinUsd: 250_000 };
  test('drops below-mcap, wash, bundler-heavy, and address-less rows', () => {
    expect(quickFilterZapRank({ address: 'a', market_cap: 100_000 }, cfg)).toBe(false);
    expect(quickFilterZapRank({ address: 'a', is_wash_trading: true }, cfg)).toBe(false);
    expect(quickFilterZapRank({ address: 'a', bundler_rate: 0.5 }, cfg)).toBe(false);
    expect(quickFilterZapRank({ market_cap: 1e9 }, cfg)).toBe(false);
  });
  test('does NOT require smart-money (unlike the drawdown quick filter)', () => {
    expect(quickFilterZapRank({ address: 'a', market_cap: 1e6, smart_degen_count: 0 }, cfg)).toBe(true);
  });
  test('missing optional fields never drop a candidate', () => {
    expect(quickFilterZapRank({ address: 'a' }, cfg)).toBe(true);
  });
});

// --- pure: volume ----------------------------------------------------------
describe('max5mVolume', () => {
  test('returns the largest single-candle volume (coercing strings)', () => {
    expect(max5mVolume([{ volume: '100' }, { volume: 30_000 }, { volume: '25000' }])).toBe(30_000);
    expect(max5mVolume([])).toBe(0);
  });
});

// --- pure: base filter -----------------------------------------------------
describe('zapBaseFilter', () => {
  const cfg = { marketCapMinUsd: 250_000, athTolerancePct: 3 };

  const atAth: GmgnTokenInfo = {
    market_cap: 500_000,
    price: 1.0,
    ath_price: 1.0, // drawdown 0 → at ATH
    open_timestamp: openedAt,
  };

  test('passes at a fresh ATH with mcap within bounds', () => {
    const r = zapBaseFilter(atAth, cfg, { nowMs: NOW });
    expect(r.pass).toBe(true);
    expect(r.drawdownPct).toBeCloseTo(0, 5);
    expect(r.marketCap).toBe(500_000);
  });

  test('fails when not at the ATH (drawdown beyond tolerance)', () => {
    const r = zapBaseFilter({ ...atAth, price: 0.8 }, cfg, { nowMs: NOW }); // 20% down
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('not at ATH'))).toBe(true);
  });

  test('fails on low market cap', () => {
    expect(zapBaseFilter({ ...atAth, market_cap: 100_000 }, cfg, { nowMs: NOW }).pass).toBe(false);
  });

  test('is age-agnostic: an old token still passes (no age gate)', () => {
    const old = Math.floor((NOW - 30 * 24 * HOUR) / 1000); // 30 days
    const r = zapBaseFilter({ ...atAth, open_timestamp: old }, cfg, { nowMs: NOW });
    expect(r.pass).toBe(true);
    expect(r.ageHours).toBeCloseTo(30 * 24, 0);
  });

  test('passes even when the token age is unknown (no timestamp)', () => {
    const r = zapBaseFilter(
      { ...atAth, open_timestamp: undefined, creation_timestamp: undefined },
      cfg,
      { nowMs: NOW },
    );
    expect(r.pass).toBe(true);
    expect(r.ageHours).toBe(0);
  });

  test('treats a new high above the stored ATH as the ATH (drawdown 0, not negative)', () => {
    const r = zapBaseFilter({ ...atAth, price: 1.2, ath_price: 1.0 }, cfg, { nowMs: NOW });
    expect(r.pass).toBe(true);
    expect(r.athPrice).toBe(1.2);
    expect(r.drawdownPct).toBe(0);
  });

  test('fails closed on a missing price even with a valid ATH', () => {
    const r = zapBaseFilter({ ...atAth, price: undefined }, cfg, { nowMs: NOW });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes('current price unavailable'))).toBe(true);
  });

  test('uses the kline ATH fallback when ath_price is missing', () => {
    const r = zapBaseFilter({ ...atAth, ath_price: undefined }, cfg, { nowMs: NOW, klineAth: 1.0 });
    expect(r.pass).toBe(true);
    expect(r.athPrice).toBe(1.0);
  });
});

// --- pure: supertrend ------------------------------------------------------
describe('computeSupertrend', () => {
  const rising = (n: number): GmgnKlineCandle[] =>
    Array.from({ length: n }, (_, i) => {
      const c = 1.0 + i * 0.05;
      return { open: c - 0.02, close: c, high: c + 0.02, low: c - 0.03, volume: 1000 };
    });
  const falling = (n: number): GmgnKlineCandle[] =>
    Array.from({ length: n }, (_, i) => {
      const c = 2.0 - i * 0.05;
      return { open: c + 0.02, close: c, high: c + 0.03, low: c - 0.02, volume: 1000 };
    });

  test('a steady uptrend is bullish', () => {
    const st = computeSupertrend(rising(20), 10, 3);
    expect(st).not.toBeNull();
    expect(st!.bullish).toBe(true);
    expect(st!.direction).toBe('up');
  });

  test('a steady downtrend is bearish', () => {
    const st = computeSupertrend(falling(20), 10, 3);
    expect(st).not.toBeNull();
    expect(st!.bullish).toBe(false);
  });

  test('returns null with insufficient candles', () => {
    expect(computeSupertrend(rising(5), 10, 3)).toBeNull();
  });

  test('skips malformed candles rather than throwing', () => {
    const withGap: GmgnKlineCandle[] = [...rising(20), { close: 'x' } as GmgnKlineCandle];
    expect(computeSupertrend(withGap, 10, 3)?.bullish).toBe(true);
  });

  test('reads the trend correctly even when candles arrive newest-first', () => {
    const asc: GmgnKlineCandle[] = Array.from({ length: 20 }, (_, i) => {
      const c = 1.0 + i * 0.05;
      return { time: 1000 + i, open: c - 0.02, close: c, high: c + 0.02, low: c - 0.03, volume: 1000 };
    });
    const desc = [...asc].reverse(); // simulate a newest-first GMGN payload
    expect(computeSupertrend(desc, 10, 3)?.bullish).toBe(true);
    expect(computeSupertrend(asc, 10, 3)?.bullish).toBe(true); // same as already-sorted
  });
});

// --- pure: zap security severity -------------------------------------------
describe('partitionZapSecurity', () => {
  test('downgrades snipers / holder concentration to warnings (not blocks)', () => {
    const p = partitionZapSecurity(
      screenSecurity({
        renounced_mint: 1,
        renounced_freeze_account: 1,
        sniper_count: 25,
        top_10_holder_rate: 0.6,
      }),
    );
    expect(p.blocking).toEqual([]);
    expect(p.warnings.some((w) => w.includes('sniper_count'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('top_10_holder_rate'))).toBe(true);
  });

  test('keeps genuinely dangerous checks as hard blocks', () => {
    const p = partitionZapSecurity(screenSecurity({ rug_ratio: 0.9 }));
    expect(p.blocking.some((b) => b.includes('rug_ratio'))).toBe(true);
    expect(p.blocking.some((b) => b.includes('mint authority'))).toBe(true); // unrenounced
  });
});

// --- scanner orchestration -------------------------------------------------
function jsonRes(body: unknown, status = 200): GmgnFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => '' };
}

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

// Price/ATH consistent with the rising 15m series' last close (~1.95).
const PRICE = 1.95;
const passingInfo = {
  symbol: 'WIF',
  name: 'dogwifhat',
  market_cap: 500_000,
  price: PRICE,
  ath_price: PRICE,
  open_timestamp: openedAt,
};

const rising15m = {
  list: Array.from({ length: 20 }, (_, i) => {
    const c = 1.0 + i * 0.05;
    return { open: c - 0.02, close: c, high: c + 0.02, low: c - 0.03, volume: '1000' };
  }),
};
const falling15m = {
  list: Array.from({ length: 20 }, (_, i) => {
    const c = 2.0 - i * 0.05;
    return { open: c + 0.02, close: c, high: c + 0.03, low: c - 0.02, volume: '1000' };
  }),
};
// Recent 5m: a hot candle clearing the volume floor with a high at the ATH.
const hot5m = {
  list: [
    { volume: '10000', close: '1.90', high: '1.92' },
    { volume: '30000', close: `${PRICE}`, high: `${PRICE}` },
  ],
};
const cold5m = {
  list: [
    { volume: '1000', close: '1.90', high: '1.92' },
    { volume: '2000', close: `${PRICE}`, high: `${PRICE}` },
  ],
};

function routes(over: Partial<Record<'info' | 'security' | 'k5' | 'k15', unknown>> = {}): Array<[string, unknown]> {
  return [
    ['/v1/market/rank', { data: { data: { rank: [{ address: 'MINT1', symbol: 'WIF', market_cap: 500_000 }] } } }],
    ['/v1/token/info', { data: over.info ?? passingInfo }],
    ['/v1/token/security', { data: over.security ?? cleanSecurity }],
    ['/v1/market/token_top_holders', { data: { list: [{ address: 's1', amount_percentage: 0.02 }] } }],
    ['/v1/market/token_top_traders', { data: { list: [] } }],
    ['resolution=15m', { data: over.k15 ?? rising15m }],
    ['resolution=1h', { data: rising15m }],
    ['resolution=5m', { data: over.k5 ?? hot5m }],
  ];
}

function makeClient(rs: Array<[string, unknown]>): GmgnClient {
  return new GmgnClient(
    { baseUrl: 'https://x', apiKey: 'k', attempts: 1, backoffMs: 0 },
    { fetch: routerFetch(rs), uuid: () => 'u', now: () => NOW, sleep: async () => {} },
  );
}

async function newStore(): Promise<GmgnScreenedStore> {
  const path = join(tmpdir(), `zap-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const s = new GmgnScreenedStore(path, { writer: async () => {}, now: () => NOW });
  await s.init();
  return s;
}

describe('ZapScanner.scanOnce', () => {
  test('a fresh-ATH breakout is qualified, alerted, and recorded', async () => {
    const store = await newStore();
    const sent: string[][] = [];
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes()),
      store,
      notify: async (msgs) => {
        sent.push(msgs);
        return true;
      },
      now: () => NOW,
    });
    const r = await scanner.scanOnce();
    expect(r.length).toBe(1);
    expect(r[0]!.symbol).toBe('WIF');
    expect(r[0]!.vol5mUsd).toBe(30_000);
    expect(sent.length).toBe(1);
    expect(sent[0]![0]).toContain('Zap In Reminder');
    expect(store.wasRecentlyAlerted('MINT1', zcfg().dedupeMs)).toBe(true);
  });

  test('scanNow returns a cycle summary', async () => {
    const store = await newStore();
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes()),
      store,
      notify: async () => true,
      now: () => NOW,
    });
    const summary = await scanner.scanNow();
    expect(summary).not.toBeNull();
    expect(summary!.qualified).toBe(1);
    expect(summary!.fresh).toBe(1);
    expect(summary!.delivered).toBe(true);
  });

  test('drops a token with weak 5m volume (no alert)', async () => {
    const store = await newStore();
    let notified = false;
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes({ k5: cold5m })),
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

  test('drops a token on a bearish 15m Supertrend', async () => {
    const store = await newStore();
    let notified = false;
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes({ k15: falling15m })),
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

  test('blocks an unsafe token (security hard-fail) before alerting', async () => {
    const store = await newStore();
    let notified = false;
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes({ security: { ...cleanSecurity, rug_ratio: 0.9 } })),
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

  test('does not block on high snipers / holder concentration (warns instead)', async () => {
    const store = await newStore();
    let notified = false;
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes({ security: { ...cleanSecurity, sniper_count: 25, top_10_holder_rate: 0.6 } })),
      store,
      notify: async () => {
        notified = true;
        return true;
      },
      now: () => NOW,
    });
    const r = await scanner.scanOnce();
    expect(r.length).toBe(1);
    expect(notified).toBe(true);
  });

  test('drops a token that is not at a new ATH', async () => {
    const store = await newStore();
    // price well below ath → base filter drawdown fails.
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes({ info: { ...passingInfo, price: 1.0, ath_price: 2.0 } })),
      store,
      notify: async () => true,
      now: () => NOW,
    });
    expect((await scanner.scanOnce()).length).toBe(0);
  });

  test('dedupe blocks re-alerting within the window', async () => {
    const store = await newStore();
    await store.record('MINT1', 'WIF', zcfg().dedupeMs);
    let notified = false;
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes()),
      store,
      notify: async () => {
        notified = true;
        return true;
      },
      now: () => NOW,
    });
    const r = await scanner.scanOnce();
    expect(r.length).toBe(1); // still qualified…
    expect(notified).toBe(false); // …but not re-alerted
  });

  test('an undelivered batch is not recorded (will retry next cycle)', async () => {
    const store = await newStore();
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes()),
      store,
      notify: async () => false,
      now: () => NOW,
    });
    await scanner.scanOnce();
    expect(store.wasRecentlyAlerted('MINT1', zcfg().dedupeMs)).toBe(false);
  });

  test('does not add qualifying mints to the manual AlertStore (invariant)', async () => {
    const store = await newStore();
    const watch = new AlertStore(join(tmpdir(), `zw-${Date.now()}.json`), {
      flushDelayMs: 9999,
      writer: async () => {},
    });
    await watch.init();
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes()),
      store,
      notify: async () => true,
      now: () => NOW,
    });
    await scanner.scanOnce();
    expect(watch.has('MINT1')).toBe(false);
  });
});

describe('ZapScanner shutdown', () => {
  test('does not start a cycle or notify once stopped', async () => {
    const store = await newStore();
    let notified = false;
    const scanner = new ZapScanner(zcfg(), {
      client: makeClient(routes()),
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
});
