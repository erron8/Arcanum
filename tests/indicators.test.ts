import { test, expect, describe } from 'bun:test';
import { calculateATHDrawdown } from '../src/utils/indicators';

describe('calculateATHDrawdown', () => {
  test('plan verification sample', () => {
    const r = calculateATHDrawdown([1, 2, 3, 2, 1.5], [1, 2, 3, 2, 1.5]);
    expect(r.map((x) => x.ath)).toEqual([1, 2, 3, 3, 3]);
    const dd = r.map((x) => (x.drawdownPct === null ? null : Number(x.drawdownPct.toFixed(2))));
    expect(dd).toEqual([0, 0, 0, 33.33, 50]);
  });

  test('fresh ATH yields 0 drawdown', () => {
    const r = calculateATHDrawdown([1, 2, 3], [1, 2, 3]);
    expect(r.every((x) => x.drawdownPct === 0)).toBe(true);
  });

  test('falls back to close when high is NaN', () => {
    const r = calculateATHDrawdown([NaN, NaN], [5, 4]);
    expect(r[0]!.ath).toBe(5);
    expect(r[1]!.ath).toBe(5);
    expect(Number(r[1]!.drawdownPct!.toFixed(2))).toBe(20);
  });

  test('null until a valid price is seen', () => {
    const r = calculateATHDrawdown([NaN, 2], [NaN, 2]);
    expect(r[0]!.ath).toBeNull();
    expect(r[0]!.drawdownPct).toBeNull();
    expect(r[1]!.ath).toBe(2);
  });

  test('ath <= 0 guards drawdown to null', () => {
    const r = calculateATHDrawdown([0], [0]);
    expect(r[0]!.ath).toBe(0);
    expect(r[0]!.drawdownPct).toBeNull();
  });

  test('does not mutate inputs', () => {
    const highs = [1, 2, 3];
    const closes = [1, 2, 3];
    calculateATHDrawdown(highs, closes);
    expect(highs).toEqual([1, 2, 3]);
    expect(closes).toEqual([1, 2, 3]);
  });
});
