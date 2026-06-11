import { test, expect, describe } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GmgnScreenedStore } from '../src/gmgn/store';

function tmpFile(): string {
  return join(tmpdir(), `gmgn-screened-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

/** In-memory store with a no-op writer and a controllable clock. */
async function newStore(now: () => number): Promise<GmgnScreenedStore> {
  const s = new GmgnScreenedStore(tmpFile(), { writer: async () => {}, now });
  await s.init();
  return s;
}

describe('GmgnScreenedStore dedupe', () => {
  test('not recently alerted before any record', async () => {
    const s = await newStore(() => 1000);
    expect(s.wasRecentlyAlerted('mint', 100)).toBe(false);
  });

  test('blocks a repeat within the dedupe window', async () => {
    let t = 1000;
    const s = await newStore(() => t);
    await s.record('mint', 'TKN', 1000);
    t = 1500; // 500ms later, within a 1000ms window
    expect(s.wasRecentlyAlerted('mint', 1000)).toBe(true);
  });

  test('allows a repeat once the window elapses', async () => {
    let t = 1000;
    const s = await newStore(() => t);
    await s.record('mint', 'TKN', 1000);
    t = 2500; // 1500ms later, past the 1000ms window
    expect(s.wasRecentlyAlerted('mint', 1000)).toBe(false);
  });

  test('prunes stale records on write', async () => {
    let t = 1000;
    const s = await newStore(() => t);
    await s.record('old', undefined, 1000);
    t = 5000;
    await s.record('new', undefined, 1000); // prune pass drops 'old'
    expect(s.size()).toBe(1);
    expect(s.wasRecentlyAlerted('new', 1000)).toBe(true);
  });

  test('record rethrows on write failure but keeps the in-memory record', async () => {
    const s = new GmgnScreenedStore(tmpFile(), {
      writer: async () => {
        throw new Error('disk full');
      },
      now: () => 1000,
    });
    await s.init();
    await expect(s.record('m', 'T', 1000)).rejects.toThrow('disk full');
    // Same-session dedupe still holds even though the write failed.
    expect(s.wasRecentlyAlerted('m', 1000)).toBe(true);
  });

  test('persists and reloads records', async () => {
    const path = tmpFile();
    const s1 = new GmgnScreenedStore(path, { now: () => 1000 });
    await s1.init();
    await s1.record('mint', 'TKN', 100_000);

    const s2 = new GmgnScreenedStore(path, { now: () => 1500 });
    await s2.init();
    expect(s2.wasRecentlyAlerted('mint', 100_000)).toBe(true);
  });
});
