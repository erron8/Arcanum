import { test, expect, describe } from 'bun:test';
import { buildChartData, normalizeInterval, intervalDurationMs } from '../src/fetchers/chartData';

describe('intervalDurationMs', () => {
  test('known intervals', () => {
    expect(intervalDurationMs('1_HOUR')).toBe(3_600_000);
    expect(intervalDurationMs('1h')).toBe(3_600_000);
    expect(intervalDurationMs('1_DAY')).toBe(86_400_000);
  });
  test('unknown interval falls back to 1 day', () => {
    expect(intervalDurationMs('nonsense')).toBe(86_400_000);
  });
});

describe('normalizeInterval', () => {
  test('accepts canonical', () => {
    expect(normalizeInterval('1_HOUR')).toBe('1_HOUR');
    expect(normalizeInterval('1_day')).toBe('1_DAY');
  });
  test('maps friendly aliases', () => {
    expect(normalizeInterval('1h')).toBe('1_HOUR');
    expect(normalizeInterval('15m')).toBe('15_MINUTE');
    expect(normalizeInterval('1d')).toBe('1_DAY');
  });
  test('rejects unknown / Jupiter-invalid intervals', () => {
    expect(normalizeInterval('6_HOUR')).toBeNull();
    expect(normalizeInterval('1h30m')).toBeNull();
    expect(normalizeInterval('')).toBeNull();
  });
});

describe('buildChartData', () => {
  test('converts seconds → ms and attaches ATH fields', () => {
    const raw = [
      { time: 1000, open: 1, high: 1, low: 1, close: 1, volume: 10 },
      { time: 2000, open: 2, high: 3, low: 1.5, close: 2, volume: 5 },
    ];
    const pts = buildChartData(raw);
    expect(pts.length).toBe(2);
    expect(pts[0]!.time).toBe(1_000_000);
    expect(pts[1]!.athPrice).toBe(3);
    expect(Number(pts[1]!.drawdownFromATH!.toFixed(2))).toBe(33.33);
  });

  test('drops candles with missing / non-finite OHLCV (no NaN leakage)', () => {
    const raw = [
      { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: 2, open: 2, high: 2, low: 2, close: 2 }, // missing volume
      { time: 3, open: 'x', high: 3, low: 3, close: 3, volume: 1 }, // bad open
      { time: 4, open: 4, high: NaN, low: 4, close: 4, volume: 1 }, // NaN high
      null,
      { time: 5, open: 5, high: 5, low: 5, close: 5, volume: 1 },
    ];
    const pts = buildChartData(raw);
    expect(pts.length).toBe(2);
    expect(pts.map((p) => p.close)).toEqual([1, 5]);
    expect(pts.every((p) => Number.isFinite(p.high) && Number.isFinite(p.volume))).toBe(true);
  });

  test('non-array input → empty', () => {
    expect(buildChartData(undefined)).toEqual([]);
    expect(buildChartData({})).toEqual([]);
  });
});
