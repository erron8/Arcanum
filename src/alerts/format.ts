/**
 * Shared MarkdownV2 primitives used by the rich alert renderer ({@link RichTokenView}
 * in `./richFormat`). The actual alert layout lives there; this module only holds the
 * escaping + number-formatting helpers and the message-size limit.
 */

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
