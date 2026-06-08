import { test, expect, describe } from 'bun:test';
import { parseChatIds, isChatAuthorized } from '../src/alerts/auth';

describe('parseChatIds', () => {
  test('parses comma/space separated integers', () => {
    expect(parseChatIds('1,2, 3  4')).toEqual([1, 2, 3, 4]);
  });
  test('handles negative chat ids (groups)', () => {
    expect(parseChatIds('-1001234567890, 42')).toEqual([-1001234567890, 42]);
  });
  test('drops non-numeric / non-integer junk', () => {
    expect(parseChatIds('abc, 1.5, 7')).toEqual([7]);
  });
  test('empty / undefined → []', () => {
    expect(parseChatIds(undefined)).toEqual([]);
    expect(parseChatIds('')).toEqual([]);
  });
});

describe('isChatAuthorized', () => {
  test('empty allowlist = open', () => {
    expect(isChatAuthorized([], 123)).toBe(true);
    expect(isChatAuthorized([], undefined)).toBe(true);
  });
  test('enforces allowlist when set', () => {
    expect(isChatAuthorized([1, 2], 2)).toBe(true);
    expect(isChatAuthorized([1, 2], 3)).toBe(false);
    expect(isChatAuthorized([1, 2], undefined)).toBe(false);
  });
});
