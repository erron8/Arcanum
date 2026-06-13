import { GmgnClient } from './client';
import { buildGmgnDisplay } from './scanner';
import type { RichTokenView } from '../alerts/richFormat';

const CHAIN = 'sol';

/** Fetches display fields for a single mint; null when basic info is unavailable. */
export type GmgnEnricher = (mint: string) => Promise<Partial<RichTokenView> | null>;

/**
 * Build a best-effort GMGN enricher for /watch alerts: it pulls token info, security,
 * holders/traders and a recent kline window, then maps them into rich-view display
 * fields. Every sub-fetch is guarded so a single failing endpoint still yields a
 * partial view (and a total failure simply falls back to the basic watch view).
 */
export function makeGmgnEnricher(client: GmgnClient): GmgnEnricher {
  return async (mint) => {
    const info = await client.getTokenInfo(CHAIN, mint);
    if (!info) return null;
    const [security, holders, traders] = await Promise.all([
      client.getTokenSecurity(CHAIN, mint).catch(() => null),
      client.getTopHolders(CHAIN, mint, 100).catch(() => []),
      client.getTopTraders(CHAIN, mint, 100).catch(() => []),
    ]);
    const toSec = Math.floor(Date.now() / 1000);
    const recentKline = await client
      .getKline(CHAIN, mint, '5m', toSec - 3600, toSec)
      .catch(() => []);
    return buildGmgnDisplay({ info, security, holders, traders, recentKline });
  };
}
