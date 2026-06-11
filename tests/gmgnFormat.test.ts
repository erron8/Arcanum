import { test, expect, describe } from 'bun:test';
import { formatCandidateBlock, formatCandidates } from '../src/gmgn/format';
import type { ScreenedCandidate } from '../src/gmgn/scanner';

function candidate(over: Partial<ScreenedCandidate> = {}): ScreenedCandidate {
  return {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'WIF',
    name: 'dogwifhat',
    price: 0.42,
    marketCap: 1_250_000,
    totalFeeSol: 55.5,
    ageHours: 50,
    athPrice: 1.05,
    drawdownPct: 60,
    verdict: 'PASS',
    hardFails: [],
    warnings: [],
    smartMoney: { smHolding: 3, kolHolding: 1, smExited: 2, kolExited: 0, smUnrealizedPositive: 2, topSmBuyVolume: 9000 },
    links: {
      gmgn: 'https://gmgn.ai/sol/token/MINT',
      jupiter: 'https://jup.ag/tokens/MINT',
      birdeye: 'https://birdeye.so/token/MINT?chain=solana',
    },
    ...over,
  };
}

describe('formatCandidateBlock', () => {
  test('renders the required fields for a PASS candidate', () => {
    const block = formatCandidateBlock(candidate());
    expect(block).toContain('WIF');
    expect(block).toContain('So11111111111111111111111111111111111111112');
    expect(block).toContain('PASS');
    expect(block).toContain('MCap');
    expect(block).toContain('SOL'); // fees in SOL
    expect(block).toContain('SM holding 3');
    expect(block).toContain('[GMGN]');
    expect(block).toContain('[Jupiter]');
    expect(block).toContain('[Birdeye]');
  });

  test('shows hard fails and warnings when present', () => {
    const block = formatCandidateBlock(
      candidate({ verdict: 'WARN', warnings: ['sniper_count 10 (5–20)'] }),
    );
    expect(block).toContain('WARN');
    expect(block).toContain('sniper'); // underscore is MarkdownV2-escaped (sniper\_count)
  });

  test('escapes MarkdownV2 specials in the period-containing fields', () => {
    const block = formatCandidateBlock(candidate());
    // The drawdown "60.00%" period must be escaped for MarkdownV2.
    expect(block).toContain('60\\.00');
  });

  test('escapes ) in an API-provided link and drops non-http links', () => {
    const block = formatCandidateBlock(
      candidate({
        links: { gmgn: 'https://gmgn.ai/x)y', jupiter: 'javascript:alert(1)', birdeye: undefined },
      }),
    );
    expect(block).toContain('https://gmgn.ai/x\\)y'); // ) escaped so the link can't break
    expect(block).toContain('[GMGN]');
    expect(block).not.toContain('javascript:'); // non-http destination dropped
    expect(block).not.toContain('[Jupiter]');
  });
});

describe('formatCandidates', () => {
  test('single candidate gets a singular header', () => {
    const msgs = formatCandidates([candidate()]);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('GMGN Screening Alert');
  });

  test('splits a large batch across multiple messages under the limit', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      candidate({ mint: `mint${i}`, symbol: `T${i}` }),
    );
    const msgs = formatCandidates(many, 1000); // tiny limit forces splitting
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(1000);
  });

  test('empty input yields no messages', () => {
    expect(formatCandidates([])).toEqual([]);
  });

  test('an oversized single block falls back to a minimal valid block under the limit', () => {
    // A normal full block is a few hundred chars; a 120-char limit forces the fallback.
    const msgs = formatCandidates([candidate()], 120);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(120);
    // The minimal block still carries the mint + drawdown.
    expect(msgs.join('\n')).toContain('from ATH');
    expect(msgs.join('\n')).toContain('So11111111111111111111111111111111111111112');
  });
});
