import { test, expect, describe } from 'bun:test';
import {
  escMarkdownV2,
  fmtPrice,
  formatAlertMessages,
  TELEGRAM_MESSAGE_LIMIT,
} from '../src/alerts/format';
import type { AlertPayload } from '../src/models/types';

function payload(i: number): AlertPayload {
  const mint = `Mint${String(i).padStart(40, '0')}`;
  return {
    mint,
    symbol: `TKN${i}`,
    price: 1.5e-7,
    ath: 3e-7,
    drawdownPct: 50,
    threshold: 40,
    jupiterUrl: `https://jup.ag/tokens/${mint}`,
    birdeyeUrl: `https://birdeye.so/token/${mint}?chain=solana`,
  };
}

describe('escMarkdownV2', () => {
  test('escapes special chars', () => {
    expect(escMarkdownV2('a.b-c!')).toBe('a\\.b\\-c\\!');
  });
});

describe('fmtPrice', () => {
  test('uses exponential for tiny prices (no precision loss)', () => {
    expect(fmtPrice(1.5e-7)).toBe('1.5000e-7');
  });
  test('fixed for normal prices', () => {
    expect(fmtPrice(1.23456)).toBe('1.2346');
  });
});

describe('formatAlertMessages', () => {
  test('single alert → one message with header', () => {
    const msgs = formatAlertMessages([payload(1)], 'native');
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('ATH Drawdown Alert');
  });

  test('every message stays under the limit when batching many alerts', () => {
    const many = Array.from({ length: 200 }, (_, i) => payload(i));
    const msgs = formatAlertMessages(many, 'native');
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });

  test('empty batch → no messages', () => {
    expect(formatAlertMessages([], 'native')).toEqual([]);
  });

  test('falls back to a minimal valid block instead of slicing markdown', () => {
    // Tiny limit forces the oversized path; the result must not be a raw slice
    // (which could cut an escape sequence) and must stay valid + bounded.
    const p = payload(7);
    const msgs = formatAlertMessages([p], 'native', 80);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const body = msgs.join('\n');
    expect(body).toContain(p.mint); // minimal block keeps the full mint
    expect(body).toContain('down');
    // No dangling backslash that would indicate a sliced escape sequence.
    expect(/\\$/.test(msgs[msgs.length - 1]!)).toBe(false);
  });

  test('clamps an absurdly long symbol', () => {
    const p = { ...payload(1), symbol: 'X'.repeat(500) };
    const msgs = formatAlertMessages([p], 'native');
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });
});
