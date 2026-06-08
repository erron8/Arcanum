import { test, expect, describe } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertStore } from '../src/alerts/store';
import { AthMonitor } from '../src/alerts/athMonitor';
import type { ChartFetcher } from '../src/alerts/athMonitor';
import { buildConfig } from '../src/alerts/config';
import type { AppConfig } from '../src/alerts/config';
import type { ChartDataPoint } from '../src/models/types';

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...buildConfig({}), fetchAttempts: 1, fetchBackoffMs: 0, ...overrides };
}

/** Fetcher whose last candle reports a given current price + rolling ATH. */
function fetcherWith(price: number, athPrice: number): ChartFetcher {
  return async () =>
    [
      {
        time: Date.now(), // fresh candle so the staleness guard doesn't skip it
        open: price,
        high: athPrice,
        low: price,
        close: price,
        volume: 0,
        athPrice,
        drawdownFromATH: athPrice > 0 ? Math.max(0, ((athPrice - price) / athPrice) * 100) : 0,
      } as ChartDataPoint,
    ];
}

async function newStore(): Promise<AlertStore> {
  const path = join(tmpdir(), `mon-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const s = new AlertStore(path, { flushDelayMs: 9999, writer: async () => {} });
  await s.init();
  return s;
}

describe('AthMonitor state machine', () => {
  test('fires when drawdown >= threshold, transitions to TRIGGERED', async () => {
    const store = await newStore();
    store.upsertWatch('m', 50);
    store.updatePersistedAth('m', 100);
    const mon = new AthMonitor(store, cfg(), fetcherWith(40, 100)); // 60% down
    mon.setSink((alerts) => alerts.map((a) => a.mint)); // accept delivery
    const payloads = await mon.pollOnce();
    expect(payloads.length).toBe(1);
    expect(Math.round(payloads[0]!.drawdownPct)).toBe(60);
    expect(payloads[0]!.threshold).toBe(50);
    expect(store.get('m')!.state).toBe('TRIGGERED');
  });

  test('does NOT consume an alert the sink did not accept (no delivery path)', async () => {
    const store = await newStore();
    store.upsertWatch('m', 50);
    store.updatePersistedAth('m', 100);
    const mon = new AthMonitor(store, cfg(), fetcherWith(40, 100));
    mon.setSink(() => []); // accept nothing (e.g. no subscribers)
    const payloads = await mon.pollOnce();
    expect(payloads.length).toBe(1); // it fired…
    expect(store.get('m')!.state).toBe('ARMED'); // …but stays ARMED, will re-fire

    // Once a delivery path exists, the next cycle consumes it.
    mon.setSink((alerts) => alerts.map((a) => a.mint));
    await mon.pollOnce();
    expect(store.get('m')!.state).toBe('TRIGGERED');
  });

  test('only accepted mints are marked TRIGGERED', async () => {
    const store = await newStore();
    for (const m of ['a', 'b']) {
      store.upsertWatch(m, 50);
      store.updatePersistedAth(m, 100);
    }
    const mon = new AthMonitor(store, cfg(), fetcherWith(40, 100)); // both 60% down
    mon.setSink((alerts) => alerts.map((a) => a.mint).filter((m) => m === 'a')); // only 'a'
    await mon.pollOnce();
    expect(store.get('a')!.state).toBe('TRIGGERED');
    expect(store.get('b')!.state).toBe('ARMED');
  });

  test('does not fire below threshold', async () => {
    const store = await newStore();
    store.upsertWatch('m', 50);
    store.updatePersistedAth('m', 100);
    const mon = new AthMonitor(store, cfg(), fetcherWith(70, 100)); // 30% down
    expect((await mon.pollOnce()).length).toBe(0);
    expect(store.get('m')!.state).toBe('ARMED');
  });

  test('reconciles ATH upward with persisted (computed lower)', async () => {
    const store = await newStore();
    store.upsertWatch('m', 40);
    store.updatePersistedAth('m', 200);
    const mon = new AthMonitor(store, cfg(), fetcherWith(100, 100)); // computed ath 100 < 200
    const payloads = await mon.pollOnce();
    expect(payloads[0]!.ath).toBe(200);
    expect(Math.round(payloads[0]!.drawdownPct)).toBe(50); // (200-100)/200
  });

  test('updates persisted ATH when computed is higher', async () => {
    const store = await newStore();
    store.upsertWatch('m', 90);
    store.updatePersistedAth('m', 100);
    const mon = new AthMonitor(store, cfg(), fetcherWith(150, 150));
    await mon.pollOnce();
    expect(store.get('m')!.persistedAth).toBe(150);
  });

  test('no re-arm within cooldown', async () => {
    const store = await newStore();
    store.upsertWatch('m', 50);
    store.updatePersistedAth('m', 100);
    store.markTriggered('m', Date.now()); // just alerted
    const mon = new AthMonitor(store, cfg({ alertCooldownMs: 10 ** 9 }), fetcherWith(100, 100));
    await mon.pollOnce();
    expect(store.get('m')!.state).toBe('TRIGGERED'); // still triggered
  });

  test('re-arms when cooled and recovered past hysteresis', async () => {
    const store = await newStore();
    store.upsertWatch('m', 50);
    store.updatePersistedAth('m', 100);
    store.markTriggered('m', Date.now() - 1000);
    const mon = new AthMonitor(
      store,
      cfg({ alertCooldownMs: 0, recoveryHysteresisPct: 5 }),
      fetcherWith(100, 100), // 0% drawdown < 45 target
    );
    await mon.pollOnce();
    expect(store.get('m')!.state).toBe('ARMED');
  });

  test('stays triggered when cooled but not recovered enough', async () => {
    const store = await newStore();
    store.upsertWatch('m', 50);
    store.updatePersistedAth('m', 100);
    store.markTriggered('m', Date.now() - 1000);
    const mon = new AthMonitor(
      store,
      cfg({ alertCooldownMs: 0, recoveryHysteresisPct: 5 }),
      fetcherWith(52, 100), // 48% drawdown, target 45 → not recovered
    );
    await mon.pollOnce();
    expect(store.get('m')!.state).toBe('TRIGGERED');
  });

  test('degenerate threshold <= hysteresis re-arms only at full recovery (clamped)', async () => {
    const store = await newStore();
    store.upsertWatch('m', 5);
    store.updatePersistedAth('m', 100);
    const c = cfg({ alertCooldownMs: 0, recoveryHysteresisPct: 5 });

    store.markTriggered('m', Date.now() - 1000);
    await new AthMonitor(store, c, fetcherWith(99, 100)).pollOnce(); // 1% down
    expect(store.get('m')!.state).toBe('TRIGGERED'); // not fully recovered

    await new AthMonitor(store, c, fetcherWith(100, 100)).pollOnce(); // 0% down
    expect(store.get('m')!.state).toBe('ARMED'); // clamped target lets it re-arm
  });

  test('one failing token never kills the sweep', async () => {
    const store = await newStore();
    store.upsertWatch('bad', 50);
    store.upsertWatch('good', 50);
    store.updatePersistedAth('good', 100);
    const fetcher: ChartFetcher = async (mint) => {
      if (mint === 'bad') throw new Error('boom');
      return fetcherWith(40, 100)(mint);
    };
    const mon = new AthMonitor(store, cfg(), fetcher);
    const payloads = await mon.pollOnce();
    expect(payloads.length).toBe(1);
    expect(payloads[0]!.mint).toBe('good');
  });

  test('retries fetch per fetchAttempts', async () => {
    const store = await newStore();
    store.upsertWatch('m', 50);
    store.updatePersistedAth('m', 100);
    let calls = 0;
    const fetcher: ChartFetcher = async (mint) => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return fetcherWith(40, 100)(mint);
    };
    const mon = new AthMonitor(store, cfg({ fetchAttempts: 3, fetchBackoffMs: 0 }), fetcher);
    const payloads = await mon.pollOnce();
    expect(calls).toBe(2);
    expect(payloads.length).toBe(1);
  });

  test('skips firing on a stale candle', async () => {
    const store = await newStore();
    store.upsertWatch('m', 50);
    store.updatePersistedAth('m', 100);
    const stale: ChartFetcher = async () => {
      const c = fetcherWith(10, 100)('m');
      const arr = await c;
      arr[0]!.time = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days old
      return arr;
    };
    const mon = new AthMonitor(store, cfg({ interval: '1_DAY', staleCandleMultiplier: 3 }), stale);
    const payloads = await mon.pollOnce();
    expect(payloads.length).toBe(0); // would be 90% down, but data is stale → no alert
    expect(store.get('m')!.state).toBe('ARMED');
  });

  test('ignores persisted ATH stored in a different quote (no inflation)', async () => {
    const store = await newStore();
    store.upsertWatch('m', 40);
    store.updatePersistedAth('m', 1000, 'usd'); // USD-denominated ATH
    const mon = new AthMonitor(store, cfg({ quote: 'native' }), fetcherWith(50, 100));
    const payloads = await mon.pollOnce();
    // ATH must be the native computed 100, not the incompatible USD 1000.
    expect(payloads[0]!.ath).toBe(100);
    expect(Math.round(payloads[0]!.drawdownPct)).toBe(50);
    expect(store.get('m')!.quote).toBe('native');
    expect(store.get('m')!.persistedAth).toBe(100);
  });

  test('bounded concurrency processes every token without exceeding the limit', async () => {
    const store = await newStore();
    const n = 12;
    for (let i = 0; i < n; i++) {
      store.upsertWatch(`m${i}`, 50);
      store.updatePersistedAth(`m${i}`, 100);
    }
    let active = 0;
    let maxActive = 0;
    const seen = new Set<string>();
    const fetcher: ChartFetcher = async (mint) => {
      active++;
      maxActive = Math.max(maxActive, active);
      seen.add(mint);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return fetcherWith(40, 100)(mint);
    };
    const mon = new AthMonitor(store, cfg({ pollConcurrency: 4 }), fetcher);
    const payloads = await mon.pollOnce();
    expect(seen.size).toBe(n);
    expect(payloads.length).toBe(n);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1); // actually ran in parallel
  });
});
