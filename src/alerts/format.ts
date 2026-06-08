import type { AlertPayload } from '../models/types';

/** Telegram hard limit is 4096 chars; stay well under to leave headroom. */
export const TELEGRAM_MESSAGE_LIMIT = 3800;

/** Escape text for Telegram MarkdownV2. */
export function escMarkdownV2(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return 'n/a';
  if (p === 0) return '0';
  const abs = Math.abs(p);
  if (abs >= 1) return p.toFixed(4);
  if (abs >= 1e-4) return p.toFixed(8);
  return p.toExponential(4); // preserve precision for tiny prices
}

export const fmtPct = (p: number): string => p.toFixed(2);

function shortMint(mint: string): string {
  return mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/** Cap a symbol so a pathologically long one can't bloat a message block. */
const MAX_SYMBOL_LEN = 32;
function clampSymbol(symbol: string): string {
  return symbol.length > MAX_SYMBOL_LEN ? `${symbol.slice(0, MAX_SYMBOL_LEN)}…` : symbol;
}

/** Render one alert into a MarkdownV2 block. */
export function formatAlertBlock(a: AlertPayload, quote: 'native' | 'usd'): string {
  const q = quote === 'usd' ? 'USD' : 'SOL';
  const name = escMarkdownV2(a.symbol ? clampSymbol(a.symbol) : shortMint(a.mint));
  return [
    `*${name}*  \`${escMarkdownV2(a.mint)}\``,
    `Down *${escMarkdownV2(fmtPct(a.drawdownPct))}%* from ATH \\(threshold ${escMarkdownV2(fmtPct(a.threshold))}%\\)`,
    `Price: ${escMarkdownV2(fmtPrice(a.price))} ${q}  ·  ATH: ${escMarkdownV2(fmtPrice(a.ath))} ${q}`,
    `[Jupiter](${a.jupiterUrl}) · [Birdeye](${a.birdeyeUrl})`,
  ].join('\n');
}

/**
 * A minimal, guaranteed-valid MarkdownV2 block used when the full block would
 * exceed the message limit. Never slices mid-escape: it is built from a short,
 * bounded set of fields (mint ≤ 44 chars, small numbers) so it is always valid.
 */
function minimalAlertBlock(a: AlertPayload): string {
  return `🔻 \`${escMarkdownV2(a.mint)}\` down ${escMarkdownV2(fmtPct(a.drawdownPct))}% from ATH`;
}

/**
 * Turn a batch of alerts into one or more MarkdownV2 messages, each guaranteed to
 * stay under `limit` so an oversized batch never drops all alerts. A single block
 * larger than the limit is emitted on its own (best effort).
 */
export function formatAlertMessages(
  alerts: AlertPayload[],
  quote: 'native' | 'usd',
  limit: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (alerts.length === 0) return [];
  // If even the full block doesn't fit, fall back to a minimal valid block rather
  // than slicing markdown mid-token (which Telegram would reject).
  const blocks = alerts.map((a) => {
    const full = formatAlertBlock(a, quote);
    return full.length <= limit ? full : minimalAlertBlock(a);
  });
  const messages: string[] = [];
  let current = '';

  const header =
    alerts.length === 1
      ? '🔻 *ATH Drawdown Alert*'
      : `🔻 *ATH Drawdown Alerts* \\(${alerts.length}\\)`;

  const flush = (): void => {
    if (current) messages.push(current);
    current = '';
  };

  // Header lives in the first message only.
  current = header;

  for (const block of blocks) {
    const addition = `\n\n${block}`;
    if (current.length + addition.length > limit) {
      flush();
      // Start a fresh message with this block (no header on continuation messages).
      current = block;
    } else {
      current += current === '' ? block : addition;
    }
  }
  flush();
  return messages;
}
