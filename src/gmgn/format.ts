import { escMarkdownV2 as esc, fmtPrice, fmtPct, TELEGRAM_MESSAGE_LIMIT } from '../alerts/format';
import type { ScreenedCandidate } from './scanner';

const VERDICT_EMOJI: Record<ScreenedCandidate['verdict'], string> = {
  PASS: '✅',
  WARN: '⚠️',
  FAIL: '⛔',
};

/** Compact USD market-cap label (e.g. 1.2M, 340K). */
function fmtMcap(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return 'n/a';
  if (usd >= 1e9) return `${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `${(usd / 1e3).toFixed(1)}K`;
  return usd.toFixed(0);
}

/** Human-friendly token age from hours. */
function fmtAge(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return 'n/a';
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

const MAX_NAME_LEN = 32;
function clampName(s: string): string {
  return s.length > MAX_NAME_LEN ? `${s.slice(0, MAX_NAME_LEN)}…` : s;
}

function shortMint(mint: string): string {
  return mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

function smartMoneyLine(sm: ScreenedCandidate['smartMoney']): string {
  // Build raw text then escape once; the middle-dot separator is not a MarkdownV2 special.
  const raw =
    `SM holding ${sm.smHolding} · KOL holding ${sm.kolHolding} · ` +
    `SM exited ${sm.smExited} · SM unreal+ ${sm.smUnrealizedPositive}`;
  return esc(raw);
}

/**
 * Sanitize a URL for use as a MarkdownV2 link destination. Returns null unless it's
 * a plain `http(s)://…` URL with no whitespace, then escapes the two characters that
 * can break a `(...)` link (`\` and `)`). This matters because `links.gmgn` can come
 * from API data — an unescaped `)` would corrupt the whole message.
 */
function safeLinkDest(u: string | undefined): string | null {
  if (!u || !/^https?:\/\/\S+$/.test(u)) return null;
  return u.replace(/[\\)]/g, '\\$&');
}

function linkLine(links: ScreenedCandidate['links']): string | null {
  const out: string[] = [];
  const g = safeLinkDest(links.gmgn);
  const j = safeLinkDest(links.jupiter);
  const b = safeLinkDest(links.birdeye);
  if (g) out.push(`[GMGN](${g})`);
  if (j) out.push(`[Jupiter](${j})`);
  if (b) out.push(`[Birdeye](${b})`);
  return out.length > 0 ? out.join(' · ') : null;
}

/**
 * A minimal, guaranteed-valid MarkdownV2 block used when the full block would exceed
 * the message limit. Built from a short, bounded set of fields (mint ≤ 44 chars, a
 * small number, a fixed verdict word) so it is always valid and small.
 */
function minimalCandidateBlock(c: ScreenedCandidate): string {
  return (
    `${VERDICT_EMOJI[c.verdict]} \`${esc(c.mint)}\` down ` +
    `${esc(fmtPct(c.drawdownPct))}% from ATH \\(${c.verdict}\\)`
  );
}

/** Render one screened candidate into a MarkdownV2 block. */
export function formatCandidateBlock(c: ScreenedCandidate): string {
  const label = c.symbol ?? c.name ?? shortMint(c.mint);
  const lines: string[] = [
    `${VERDICT_EMOJI[c.verdict]} *${esc(clampName(label))}*  \`${esc(c.mint)}\``,
    `Down *${esc(fmtPct(c.drawdownPct))}%* from ATH \\(verdict *${c.verdict}*\\)`,
    `Price: ${esc(fmtPrice(c.price))}  ·  MCap: $${esc(fmtMcap(c.marketCap))}`,
    `Fees: ${esc(c.totalFeeSol.toFixed(1))} SOL  ·  Age: ${esc(fmtAge(c.ageHours))}  ·  ATH: ${esc(fmtPrice(c.athPrice))}`,
    smartMoneyLine(c.smartMoney),
  ];

  if (c.hardFails.length > 0) {
    lines.push(`🚫 ${esc(c.hardFails.slice(0, 5).join('; '))}`);
  }
  if (c.warnings.length > 0) {
    lines.push(`⚠️ ${esc(c.warnings.slice(0, 5).join('; '))}`);
  }
  const links = linkLine(c.links);
  if (links) lines.push(links);

  return lines.join('\n');
}

/**
 * Turn a batch of candidates into one or more MarkdownV2 messages, each kept under
 * `limit` so an oversized batch never drops every alert.
 */
export function formatCandidates(
  candidates: ScreenedCandidate[],
  limit: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (candidates.length === 0) return [];

  const header =
    candidates.length === 1
      ? '🔎 *GMGN Screening Alert*'
      : `🔎 *GMGN Screening Alerts* \\(${candidates.length}\\)`;

  // If even the full block doesn't fit on its own, fall back to a minimal valid
  // block rather than emitting an oversized message Telegram would reject.
  const blocks = candidates.map((c) => {
    const full = formatCandidateBlock(c);
    return full.length <= limit ? full : minimalCandidateBlock(c);
  });

  const messages: string[] = [];
  let current = header;

  for (const block of blocks) {
    const addition = `\n\n${block}`;
    if (current.length + addition.length > limit) {
      messages.push(current);
      // Start a fresh message with this block (no header on continuation messages).
      current = block;
    } else {
      current += addition;
    }
  }
  messages.push(current);
  return messages;
}
