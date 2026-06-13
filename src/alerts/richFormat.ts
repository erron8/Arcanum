import { escMarkdownV2 as esc, fmtPrice, fmtPct, TELEGRAM_MESSAGE_LIMIT } from './format';
import type { MeteoraPoolLink } from '../meteora/client';

/**
 * Rich, "scanner-style" alert layout shared by the /watch drawdown alerts and the
 * GMGN screening alerts. The view is intentionally all-optional (except `mint`):
 * any field that is absent is simply omitted from the rendered block, so the same
 * renderer works whether we have a full GMGN payload or only a Jupiter price/ATH.
 */

export type RichAlertKind = 'watch' | 'gmgn' | 'check';
export type RichVerdict = 'PASS' | 'WARN' | 'FAIL';

export interface RichHolder {
  address: string;
  /** Holding as a percentage of supply (0–100). */
  pct: number;
}

export interface RichSmartMoney {
  smHolding: number;
  kolHolding: number;
  smExited: number;
  smUnrealizedPositive: number;
}

export interface RichTokenView {
  kind: RichAlertKind;
  mint: string;
  symbol?: string;
  name?: string;
  chain?: string; // default "Solana"
  platform?: string; // launchpad, e.g. "Pump"

  priceUsd?: number;
  fdvUsd?: number;
  fdvAthUsd?: number;
  ageHours?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  vol1hUsd?: number;
  change1hPct?: number;
  athUsd?: number;
  drawdownPct?: number;

  holderCount?: number;
  topHolders?: RichHolder[];
  top10Pct?: number; // 0–100
  bundledPct?: number; // 0–100
  smartMoney?: RichSmartMoney;

  // --- alert framing ---
  threshold?: number; // /watch threshold %
  verdict?: RichVerdict; // GMGN verdict
  warnings?: string[];
  hardFails?: string[];

  socials?: { website?: string; twitter?: string; telegram?: string };
  /** Meteora DLMM pools containing this token (top pools by 24h volume). */
  meteoraPools?: MeteoraPoolLink[];
  /** Price denomination for the /watch price label (defaults to USD wording). */
  quote?: 'native' | 'usd';
}

const VERDICT_EMOJI: Record<RichVerdict, string> = { PASS: '✅', WARN: '⚠️', FAIL: '⛔' };

const MAX_NAME_LEN = 32;
function clamp(s: string, n = MAX_NAME_LEN): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function shortMint(mint: string): string {
  return mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

function shortAddr(a: string): string {
  return a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** Compact USD label (e.g. $1.2M, $340.0K). Returns undefined for absent/invalid. */
function fmtUsd(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n) || n < 0) return undefined;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(hours: number | undefined): string | undefined {
  if (hours === undefined || !Number.isFinite(hours) || hours < 0) return undefined;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/**
 * Sanitize a URL for use as a MarkdownV2 link destination: only plain http(s) URLs
 * with no whitespace, then escape the two chars that can break a `(...)` link.
 */
function safeLinkDest(u: string | undefined): string | null {
  if (!u || !/^https?:\/\/\S+$/.test(u)) return null;
  return u.replace(/[\\)]/g, '\\$&');
}

/** A MarkdownV2 `[label](url)` link, or null if the URL is unusable. Label is escaped. */
function link(label: string, url: string | undefined): string | null {
  const dest = safeLinkDest(url);
  return dest ? `[${esc(label)}](${dest})` : null;
}

// --- per-token external links (no referral codes) --------------------------

function solscanAccount(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}

/** Chart / explorer links built from the mint (plus optional launchpad page). */
function chartLinks(v: RichTokenView): string[] {
  const m = v.mint;
  const out: (string | null)[] = [
    link('DEX', `https://dexscreener.com/solana/${m}`),
    link('Birdeye', `https://birdeye.so/token/${m}?chain=solana`),
    link('GMGN', `https://gmgn.ai/sol/token/${m}`),
    link('Solscan', `https://solscan.io/token/${m}`),
  ];
  if (/pump/i.test(v.platform ?? '')) out.push(link('Pump', `https://pump.fun/${m}`));
  return out.filter((x): x is string => x !== null);
}

/** Label a DLMM pool as "PAIR binStep/baseFee%" when the config is known, else just PAIR. */
function meteoraPoolLabel(p: MeteoraPoolLink): string {
  if (p.binStep !== undefined && p.baseFeePct !== undefined) {
    return `${p.pair} ${p.binStep}/${p.baseFeePct}%`;
  }
  return p.pair;
}

function socialLinks(v: RichTokenView): string[] {
  const s = v.socials ?? {};
  return [
    link('🌐 Web', s.website),
    link('🐦 X', s.twitter),
    link('💬 TG', s.telegram),
  ].filter((x): x is string => x !== null);
}

// --- block renderer --------------------------------------------------------

/**
 * Render one token view into a MarkdownV2 block. Lines are grouped into sections
 * (title / market stats / holders / links / Meteora pools / contract) separated by a
 * blank line so the message is easy to scan and not cramped.
 */
export function formatRichBlock(v: RichTokenView): string {
  // --- title: emoji · *name* (→GMGN) · [mcap] · [drawdown · verdict/threshold] · $TICKER ---
  const emoji = v.kind === 'gmgn' ? VERDICT_EMOJI[v.verdict ?? 'PASS'] : v.kind === 'check' ? '🔍' : '🔻';
  // The token NAME links to its GMGN page (primary trading terminal).
  const gmgnUrl = `https://gmgn.ai/sol/token/${v.mint}`;
  const nameText = `*${esc(clamp(v.name ?? v.symbol ?? shortMint(v.mint)))}*`;
  const gmgnDest = safeLinkDest(gmgnUrl);
  const nameLinked = gmgnDest ? `[${nameText}](${gmgnDest})` : nameText;

  const fdvNow = fmtUsd(v.fdvUsd);
  const fdvAth = fmtUsd(v.fdvAthUsd);
  const mcapTag = fdvNow ? `  \\[*${esc(fdvNow)}*\\]` : '';
  const tagParts: string[] = [];
  if (v.drawdownPct !== undefined) tagParts.push(`⬇️*${esc(fmtPct(v.drawdownPct))}%*`);
  if (v.kind === 'gmgn' && v.verdict) tagParts.push(v.verdict);
  if (v.kind === 'watch' && v.threshold !== undefined) {
    tagParts.push(`threshold ${esc(fmtPct(v.threshold))}%`);
  }
  const tag = tagParts.length > 0 ? `  \\[${tagParts.join(' · ')}\\]` : '';

  // Ticker at the end as a plain-text cashtag (UPPERCASE) — Telegram auto-detects
  // cashtags and tapping one searches the chat for that ticker. It must stay plain
  // text (no link/code entity) for that detection to fire.
  const cashtag = v.symbol ? `  ${esc(`$${clamp(v.symbol).toUpperCase()}`)}` : '';

  const title = [`${emoji} ${nameLinked}${mcapTag}${tag}${cashtag}`];

  // --- ATH (market cap at ATH), its own section right under the title ---
  const ath: string[] = [];
  if (fdvAth) {
    ath.push(`🏔 ATH: *${esc(fdvAth)}*`);
  } else if (v.athUsd !== undefined) {
    ath.push(`🏔 ATH: *${esc(fmtPrice(v.athUsd))}* ${v.quote === 'native' ? 'SOL' : 'USD'}`);
  }

  // --- market stats ---
  const market: string[] = [];
  const chain = v.chain ?? 'Solana';
  market.push(`🌐 ${v.platform ? `${esc(chain)} @ ${esc(clamp(v.platform))}` : esc(chain)}`);
  if (v.priceUsd !== undefined) {
    market.push(`💰 ${v.quote === 'native' ? 'SOL' : 'USD'}: ${esc(fmtPrice(v.priceUsd))}`);
  }
  if (fdvNow || fdvAth) {
    const proj = fdvNow && fdvAth ? `${esc(fdvNow)} ⇨ ${esc(fdvAth)}` : esc((fdvNow ?? fdvAth)!);
    market.push(`💎 FDV: ${proj}`);
  }
  const liq = fmtUsd(v.liquidityUsd);
  if (liq) {
    let ratio = '';
    if (v.fdvUsd !== undefined && v.liquidityUsd && v.liquidityUsd > 0) {
      ratio = `  \\[x${esc((v.fdvUsd / v.liquidityUsd).toFixed(1))}\\]`;
    }
    market.push(`💦 Liq: ${esc(liq)}${ratio}`);
  }
  const vol = fmtUsd(v.volumeUsd);
  const age2 = fmtAge(v.ageHours);
  if (vol || age2) {
    const parts: string[] = [];
    if (vol) parts.push(`Vol: ${esc(vol)}`);
    if (age2) parts.push(`Age: ${esc(age2)}`);
    market.push(`📊 ${parts.join('  ·  ')}`);
  }

  // --- holders + screening flags ---
  const holders: string[] = [];
  if (v.topHolders && v.topHolders.length > 0) {
    const parts = v.topHolders
      .slice(0, 5)
      .map((h) => `[${esc(h.pct.toFixed(1))}](${safeLinkDest(solscanAccount(h.address))})`)
      .filter((s) => !s.includes('](null)'));
    const top10 = v.top10Pct !== undefined ? `  \\[top10 ${esc(v.top10Pct.toFixed(0))}%\\]` : '';
    if (parts.length > 0) holders.push(`👥 TH: ${parts.join(' · ')}${top10}`);
  }
  const holderBits: string[] = [];
  if (v.holderCount !== undefined) holderBits.push(`Holders: ${esc(String(v.holderCount))}`);
  if (v.bundledPct !== undefined) holderBits.push(`👻 Bundled ${esc(v.bundledPct.toFixed(1))}%`);
  if (holderBits.length > 0) holders.push(`🤝 ${holderBits.join('  ·  ')}`);
  if (v.smartMoney) {
    const sm = v.smartMoney;
    holders.push(
      esc(
        `🧠 SM holding ${sm.smHolding} · KOL ${sm.kolHolding} · ` +
          `SM exited ${sm.smExited} · SM unreal+ ${sm.smUnrealizedPositive}`,
      ),
    );
  }
  if (v.hardFails && v.hardFails.length > 0) {
    holders.push(`🚫 ${esc(v.hardFails.slice(0, 5).join('; '))}`);
  }
  if (v.warnings && v.warnings.length > 0) {
    holders.push(`⚠️ ${esc(v.warnings.slice(0, 5).join('; '))}`);
  }

  // --- socials + chart/explorer links ---
  const links: string[] = [];
  const socials = socialLinks(v);
  if (socials.length > 0) links.push(socials.join('  ·  '));
  const charts = chartLinks(v);
  if (charts.length > 0) links.push(`📈 ${charts.join(' · ')}`);

  // --- Meteora DLMM pools as a numbered list (top pools by TVL) ---
  const meteora: string[] = [];
  if (v.meteoraPools && v.meteoraPools.length > 0) {
    const entries = v.meteoraPools
      .map((p) => link(meteoraPoolLabel(p), p.url))
      .filter((s): s is string => s !== null);
    if (entries.length > 0) {
      meteora.push('🌊 Meteora pools:');
      entries.forEach((e, i) => meteora.push(`${i + 1}\\. ${e}`));
    }
  }

  // --- contract address ---
  const contract = [`\`${esc(v.mint)}\``];

  // Join sections with a blank line, skipping any empty section.
  return [title, ath, market, holders, links, meteora, contract]
    .filter((section) => section.length > 0)
    .map((section) => section.join('\n'))
    .join('\n\n');
}

/**
 * Minimal guaranteed-valid block used when a full block would exceed the limit, so
 * an oversized alert never drops the whole message. Built from bounded fields only.
 */
function minimalBlock(v: RichTokenView): string {
  const emoji = v.kind === 'gmgn' ? VERDICT_EMOJI[v.verdict ?? 'PASS'] : v.kind === 'check' ? '🔍' : '🔻';
  const dd = v.drawdownPct !== undefined ? ` down ${esc(fmtPct(v.drawdownPct))}% from ATH` : '';
  return `${emoji} \`${esc(v.mint)}\`${dd}`;
}

/** Header for the first message, depending on alert kind + count. */
function headerFor(kind: RichAlertKind, count: number): string {
  if (kind === 'gmgn') {
    return count === 1 ? '🔎 *GMGN Screening Alert*' : `🔎 *GMGN Screening Alerts* \\(${count}\\)`;
  }
  if (kind === 'check') {
    return count === 1 ? '🔍 *Token Check*' : `🔍 *Token Check* \\(${count}\\)`;
  }
  return count === 1 ? '🔻 *ATH Drawdown Alert*' : `🔻 *ATH Drawdown Alerts* \\(${count}\\)`;
}

/**
 * Turn token views into one or more MarkdownV2 messages, each kept under `limit`.
 * A single block that alone exceeds the limit falls back to a minimal block.
 */
export function formatRichMessages(
  views: RichTokenView[],
  limit: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (views.length === 0) return [];
  const header = headerFor(views[0]!.kind, views.length);
  const blocks = views.map((v) => {
    const full = formatRichBlock(v);
    return full.length <= limit ? full : minimalBlock(v);
  });

  const messages: string[] = [];
  let current = header;
  for (const block of blocks) {
    const addition = `\n\n${block}`;
    if (current.length + addition.length > limit) {
      messages.push(current);
      current = block; // continuation messages carry no header
    } else {
      current += addition;
    }
  }
  messages.push(current);
  return messages;
}
