import { test, expect, describe } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertStore } from '../src/alerts/store';

function tmpPath(): string {
  return join(tmpdir(), `alerts-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('AlertStore persistence', () => {
  test('persists and reloads watches', async () => {
    const path = tmpPath();
    const a = new AlertStore(path, { flushDelayMs: 5 });
    await a.init();
    a.upsertWatch('mintA', 40, { symbol: 'AAA' });
    await a.flushNow();

    const b = new AlertStore(path, { flushDelayMs: 5 });
    await b.init();
    const entry = b.get('mintA');
    expect(entry?.threshold).toBe(40);
    expect(entry?.symbol).toBe('AAA');
    expect(entry?.state).toBe('ARMED');
    await fs.rm(path, { force: true });
  });

  test('persistedAth moves up only; resetAth lowers + re-arms', async () => {
    const s = new AlertStore(tmpPath(), { flushDelayMs: 9999, writer: async () => {} });
    await s.init();
    s.upsertWatch('m', 40);
    expect(s.updatePersistedAth('m', 100)).toBe(true);
    expect(s.updatePersistedAth('m', 50)).toBe(false); // no downward move
    expect(s.get('m')!.persistedAth).toBe(100);
    expect(s.updatePersistedAth('m', 150)).toBe(true);
    expect(s.get('m')!.persistedAth).toBe(150);

    s.markTriggered('m', Date.now());
    expect(s.get('m')!.state).toBe('TRIGGERED');
    s.resetAth('m');
    expect(s.get('m')!.persistedAth).toBe(0);
    expect(s.get('m')!.state).toBe('ARMED');
  });

  test('updatePersistedAth rebases when the quote denomination changes', async () => {
    const s = new AlertStore(tmpPath(), { flushDelayMs: 9999, writer: async () => {} });
    await s.init();
    s.upsertWatch('m', 40);
    s.updatePersistedAth('m', 1000, 'usd'); // stamps the USD denomination
    expect(s.get('m')!.persistedAth).toBe(1000);
    expect(s.get('m')!.quote).toBe('usd');

    // Switching to native must not max() against the USD value — it rebases.
    s.updatePersistedAth('m', 2, 'native');
    expect(s.get('m')!.persistedAth).toBe(2);
    expect(s.get('m')!.quote).toBe('native');

    // Same-quote updates remain upward-only.
    expect(s.updatePersistedAth('m', 1, 'native')).toBe(false);
    expect(s.updatePersistedAth('m', 3, 'native')).toBe(true);
  });

  test('re-watching an existing token rebases ATH when quote changed (regression)', async () => {
    const s = new AlertStore(tmpPath(), { flushDelayMs: 9999, writer: async () => {} });
    await s.init();
    s.upsertWatch('m', 40);
    s.updatePersistedAth('m', 1000, 'usd');

    // Mirror the /watch flow for an existing token: upsert (no quote) then update.
    s.upsertWatch('m', 40);
    expect(s.get('m')!.quote).toBe('usd'); // upsert must NOT silently flip the quote
    s.updatePersistedAth('m', 2, 'native');
    expect(s.get('m')!.persistedAth).toBe(2); // rebased, not stuck at 1000
    expect(s.get('m')!.quote).toBe('native');
  });

  test('list()/get() return copies that do not mutate internal state', async () => {
    const s = new AlertStore(tmpPath(), { flushDelayMs: 9999, writer: async () => {} });
    await s.init();
    s.upsertWatch('m', 40);
    const got = s.get('m')!;
    got.threshold = 999;
    got.state = 'TRIGGERED';
    expect(s.get('m')!.threshold).toBe(40);
    expect(s.get('m')!.state).toBe('ARMED');

    const listed = s.list();
    listed.m!.persistedAth = 123456;
    expect(s.get('m')!.persistedAth).toBe(0);
  });

  test('failed flush keeps data dirty and recovers on a later write', async () => {
    let fail = true;
    const writes: string[] = [];
    const s = new AlertStore(tmpPath(), {
      flushDelayMs: 9999, // avoid the debounce timer; we flush manually
      writer: async (_p, body) => {
        if (fail) throw new Error('simulated disk failure');
        writes.push(body);
      },
    });
    await s.init();
    s.upsertWatch('m', 40);

    await expect(s.flushNow()).rejects.toThrow('simulated disk failure');
    expect(writes.length).toBe(0);

    // Recover: a subsequent successful flush must still write the pending data.
    fail = false;
    await s.flushNow();
    expect(writes.length).toBe(1);
    expect(JSON.parse(writes[0]!).m.threshold).toBe(40);

    // Nothing dirty now → no extra write.
    await s.flushNow();
    expect(writes.length).toBe(1);
  });

  test('mutation during an in-flight write is not lost (race)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writes: string[] = [];
    let firstWrite = true;
    const s = new AlertStore(tmpPath(), {
      flushDelayMs: 99_999, // avoid the debounce timer; drive flushNow manually
      writer: async (_p, body) => {
        writes.push(body);
        if (firstWrite) {
          firstWrite = false;
          await gate; // hold the first write open so a mutation can race it
        }
      },
    });
    await s.init();

    s.upsertWatch('a', 10);
    const flushing = s.flushNow(); // snapshots {a}, then blocks on the gate

    // Mutation lands while the first write is still in flight.
    s.upsertWatch('b', 20);
    release();
    await flushing;

    // The drain loop must have written a second snapshot containing both keys.
    const last = JSON.parse(writes[writes.length - 1]!);
    expect(last.a).toBeDefined();
    expect(last.b).toBeDefined();
    expect(writes.length).toBe(2);
  });

  test('corrupt file does not throw on init', async () => {
    const path = tmpPath();
    await fs.writeFile(path, '{ not json', 'utf8');
    const s = new AlertStore(path);
    await s.init();
    expect(Object.keys(s.list())).toEqual([]);
    await fs.rm(path, { force: true });
  });
});
