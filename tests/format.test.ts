import { test, expect, describe } from 'bun:test';
import { escMarkdownV2, fmtPrice } from '../src/alerts/format';

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
