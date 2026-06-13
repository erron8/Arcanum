import { test, expect, describe } from 'bun:test';
import { formatRichBlock, formatRichMessages } from '../src/alerts/richFormat';
import type { RichTokenView } from '../src/alerts/richFormat';

const MINT = 'So11111111111111111111111111111111111111112';

function gmgnView(over: Partial<RichTokenView> = {}): RichTokenView {
  return {
    kind: 'gmgn',
    mint: MINT,
    symbol: 'WIF',
    name: 'dogwifhat',
    chain: 'Solana',
    platform: 'Pump',
    priceUsd: 0.00042,
    fdvUsd: 980_000,
    fdvAthUsd: 2_650_000,
    ageHours: 52,
    liquidityUsd: 120_000,
    volumeUsd: 4_700_000,
    vol1hUsd: 61_200,
    change1hPct: -2.8,
    athUsd: 0.00113,
    drawdownPct: 62.8,
    holderCount: 4321,
    topHolders: [
      { address: 'BNEnz1YtUQWH3bRtGaGjipPxHagWLeR8YjFQWmtG3JhJ', pct: 2.0 },
      { address: 'CJTJL9KvFhWS7GJvDgiUfd8xbwDTVTrzCnaHNt5N2SWc', pct: 1.7 },
    ],
    top10Pct: 14,
    bundledPct: 2.8,
    smartMoney: { smHolding: 4, kolHolding: 2, smExited: 1, smUnrealizedPositive: 3 },
    verdict: 'WARN',
    warnings: ['sniper_count 12 (5–20)'],
    hardFails: [],
    socials: { website: 'https://wif.xyz', twitter: 'https://x.com/wif', telegram: undefined },
    ...over,
  };
}

function watchView(over: Partial<RichTokenView> = {}): RichTokenView {
  return {
    kind: 'watch',
    mint: MINT,
    symbol: 'BONK',
    chain: 'Solana',
    priceUsd: 1.42e-5,
    athUsd: 3.89e-5,
    drawdownPct: 63.5,
    threshold: 50,
    quote: 'usd',
    ...over,
  };
}

describe('formatRichBlock — GMGN', () => {
  test('renders the rich layout fields', () => {
    const b = formatRichBlock(gmgnView());
    expect(b).toContain('dogwifhat');
    expect(b).toContain(`[*dogwifhat*](https://gmgn.ai/sol/token/${MINT})`); // name links to GMGN
    expect(b).toContain('$WIF'); // ticker as a cashtag (uppercase) at the title end
    expect(b).toContain('WARN');
    expect(b).toContain('Solana @ Pump');
    expect(b).toContain('FDV');
    expect(b).toContain('⇨'); // now → ATH projection
    expect(b).toContain('Liq:');
    expect(b).toContain('SM holding 4');
    expect(b).toContain(MINT); // contract line
    expect(b).not.toContain('🤖'); // trading-bot row removed
    expect(b).toContain('[GMGN]');
    expect(b).toContain('🐦 X'); // social
    expect(b).toContain('\n\n'); // sections are separated by a blank line
    // Title carries the current market cap (bold); ATH line shows the market cap at ATH (bold).
    expect(b).toContain('\\[*$980\\.0K*\\]'); // current FDV in the title bracket, bold
    expect(b).toContain('🏔 ATH: *$2\\.65M*'); // ATH shown as market cap, bold
    expect(b).toContain('⬇️*62\\.80%*'); // drawdown bold in the tag
    expect(b).not.toContain('1H:'); // 1H line removed
  });

  test('verdict drives the leading emoji and tag', () => {
    expect(formatRichBlock(gmgnView({ verdict: 'PASS', warnings: [] }))).toContain('✅');
    expect(formatRichBlock(gmgnView({ verdict: 'FAIL', hardFails: ['rug'] }))).toContain('⛔');
  });

  test('escapes MarkdownV2 specials (period in drawdown)', () => {
    expect(formatRichBlock(gmgnView())).toContain('62\\.80');
  });

  test('top-holder amounts link to solscan accounts', () => {
    const b = formatRichBlock(gmgnView());
    expect(b).toContain('https://solscan.io/account/BNEnz1YtUQWH3bRtGaGjipPxHagWLeR8YjFQWmtG3JhJ');
  });

  test('renders Meteora pool links labeled PAIR binStep/baseFee%', () => {
    const b = formatRichBlock(
      gmgnView({
        meteoraPools: [
          {
            poolAddress: 'POOL1',
            pair: 'SOL/USDC',
            binStep: 4,
            baseFeePct: 0.04,
            url: 'https://app.meteora.ag/dlmm/POOL1',
          },
        ],
      }),
    );
    expect(b).toContain('🌊 Meteora pools:');
    // Numbered list entry; "." in 0.04 and in "1." are MarkdownV2-escaped.
    expect(b).toContain('1\\. [SOL/USDC 4/0\\.04%](https://app.meteora.ag/dlmm/POOL1)');
  });

  test('Meteora pools render as a numbered list, one per line', () => {
    const b = formatRichBlock(
      gmgnView({
        meteoraPools: [
          { poolAddress: 'P1', pair: 'A/SOL', binStep: 4, baseFeePct: 0.04, url: 'https://app.meteora.ag/dlmm/P1' },
          { poolAddress: 'P2', pair: 'A/USDC', binStep: 20, baseFeePct: 0.2, url: 'https://app.meteora.ag/dlmm/P2' },
        ],
      }),
    );
    expect(b).toContain('1\\. [A/SOL 4/0\\.04%]');
    expect(b).toContain('2\\. [A/USDC 20/0\\.2%]');
    // Each entry is on its own line.
    expect(b).toMatch(/1\\\. \[A\/SOL[^\n]*\n2\\\. \[A\/USDC/);
  });

  test('Meteora label falls back to just the pair when config is missing', () => {
    const b = formatRichBlock(
      gmgnView({
        meteoraPools: [
          { poolAddress: 'POOL1', pair: 'SOL/WIF', url: 'https://app.meteora.ag/dlmm/POOL1' },
        ],
      }),
    );
    expect(b).toContain('[SOL/WIF](https://app.meteora.ag/dlmm/POOL1)');
  });

  test('omits fields that are absent (no crash, no doubled blank lines)', () => {
    const b = formatRichBlock({ kind: 'gmgn', mint: MINT, verdict: 'PASS' });
    expect(b).toContain(MINT);
    expect(b).not.toContain('FDV');
    expect(b).not.toContain('Liq:');
    // Empty sections are dropped, so there is never a doubled (3+ newline) gap.
    expect(b).not.toMatch(/\n\n\n/);
  });
});

describe('formatRichBlock — watch', () => {
  test('uses the 🔻 header emoji and shows threshold + quote', () => {
    const b = formatRichBlock(watchView());
    expect(b).toContain('🔻');
    expect(b).toContain('$BONK');
    expect(b).toContain('threshold 50\\.00%');
    expect(b).toContain('USD:'); // quote=usd
  });

  test('native quote labels price/ATH as SOL', () => {
    const b = formatRichBlock(watchView({ quote: 'native' }));
    expect(b).toContain('SOL:');
  });
});

describe('formatRichMessages', () => {
  test('single GMGN view → one message with the screening header', () => {
    const msgs = formatRichMessages([gmgnView()]);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('GMGN Screening Alert');
  });

  test('single watch view → ATH drawdown header', () => {
    const msgs = formatRichMessages([watchView()]);
    expect(msgs[0]).toContain('ATH Drawdown Alert');
  });

  test('empty input → no messages', () => {
    expect(formatRichMessages([])).toEqual([]);
  });

  test('large batch splits across messages under the limit', () => {
    const many = Array.from({ length: 60 }, (_, i) => gmgnView({ mint: `mint${i}`, symbol: `T${i}` }));
    const msgs = formatRichMessages(many, 1500);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(1500);
  });

  test('an oversized single block falls back to a minimal valid block', () => {
    const msgs = formatRichMessages([gmgnView()], 140);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(140);
    expect(msgs.join('\n')).toContain(MINT);
  });
});
