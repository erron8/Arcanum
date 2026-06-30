import { GmgnClient } from './client';
import { buildGmgnDisplay } from './scanner';
import type { RichTokenView } from '../alerts/richFormat';

const CHAIN = 'sol';
const SECONDARY_ENRICH_TIMEOUT_MS = 7_000;

/** Fetches display fields for a single mint; null when basic info is unavailable. */
export type GmgnEnricher = (mint: string) => Promise<Partial<RichTokenView> | null>;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a best-effort GMGN enricher for /watch and /check: it pulls token info,
 * security and holders/traders, then maps them into rich-view display fields (volume
 * and age are derived from the token-info payload itself). Every sub-fetch is guarded
 * so a single failing endpoint still yields a partial view (a total failure falls back
 * to the basic view).
 */
export function makeGmgnEnricher(client: GmgnClient): GmgnEnricher {
  return async (mint) => {
    const info = await client.getTokenInfo(CHAIN, mint);
    if (!info) return null;
    const nowMs = Date.now();
    const base = buildGmgnDisplay({ info, nowMs });
    const full = Promise.all([
      client.getTokenSecurity(CHAIN, mint).catch(() => null),
      client.getTopHolders(CHAIN, mint, 100).catch(() => []),
      client.getTopTraders(CHAIN, mint, 100).catch(() => []),
    ]).then(([security, holders, traders]) =>
      buildGmgnDisplay({ info, security, holders, traders, nowMs }),
    );
    return Promise.race([
      full,
      delay(SECONDARY_ENRICH_TIMEOUT_MS).then(() => base),
    ]);
  };
}
