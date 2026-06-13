/**
 * Types for the GMGN OpenAPI surface used by the drawdown scanner.
 *
 * Fields are intentionally optional and loosely typed: GMGN responses are
 * external and may add/drop fields, so the scanner reads defensively and the
 * raw-number helpers in `client.ts` coerce string-or-number values.
 */

/** A single row from `GET /v1/market/rank` (`data.data.rank[]`). */
export interface GmgnRankItem {
  address?: string;
  symbol?: string;
  name?: string;
  price?: number;
  volume?: number;
  liquidity?: number;
  market_cap?: number;
  holder_count?: number;
  top_10_holder_rate?: number;
  smart_degen_count?: number;
  renowned_count?: number;
  rug_ratio?: number;
  bundler_rate?: number;
  rat_trader_amount_rate?: number;
  sniper_count?: number;
  bot_degen_rate?: number;
  is_wash_trading?: boolean;
  renounced_mint?: number;
  renounced_freeze_account?: number;
  creator_token_status?: string;
  open_timestamp?: number;
  creation_timestamp?: number;
}

/**
 * A price field that GMGN sometimes returns as a scalar and sometimes as a nested
 * object (`{ price: "0.00041", ... }`). Read it via `infoPrice()` in the scanner.
 */
export type GmgnPriceField = number | string | { price?: number | string };

/** Subset of `GET /v1/token/info` (`data`). */
export interface GmgnTokenInfo {
  address?: string;
  symbol?: string;
  name?: string;
  price?: GmgnPriceField;
  circulating_supply?: number | string;
  total_supply?: number | string;
  liquidity?: number | string;
  holder_count?: number;
  ath_price?: GmgnPriceField;
  market_cap?: number | string;
  trade_fee?: number | string;
  total_fee?: number | string;
  creation_timestamp?: number;
  open_timestamp?: number;
  launchpad_platform?: string;
  link?: {
    twitter_username?: string;
    website?: string;
    telegram?: string;
    gmgn?: string;
  };
  stat?: {
    top_10_holder_rate?: number;
    bot_degen_rate?: number;
    top_bundler_trader_percentage?: number;
    top_rat_trader_percentage?: number;
  };
  wallet_tags_stat?: {
    smart_wallets?: number;
    renowned_wallets?: number;
    sniper_wallets?: number;
    bundler_wallets?: number;
  };
}

/** Subset of `GET /v1/token/security` (`data`). */
export interface GmgnTokenSecurity {
  renounced_mint?: number | boolean | string;
  renounced_freeze_account?: number | boolean | string;
  is_honeypot?: string;
  rug_ratio?: number | string;
  top_10_holder_rate?: number | string;
  creator_token_status?: string;
  sniper_count?: number | string;
  is_wash_trading?: boolean;
  bundler_trader_amount_rate?: number | string;
  rat_trader_amount_rate?: number | string;
}

/** A wallet row from `token_top_holders` / `token_top_traders` (`data.list[]`). */
export interface GmgnWalletEntry {
  address?: string;
  name?: string;
  twitter_username?: string;
  tags?: string[];
  maker_token_tags?: string[];
  amount_percentage?: number;
  buy_volume_cur?: number;
  sell_volume_cur?: number;
  sell_amount_percentage?: number;
  profit?: number;
  unrealized_profit?: number;
  start_holding_at?: number | null;
  end_holding_at?: number | null;
}

/** A single OHLCV candle from `GET /v1/market/token_kline` (`data.list[]`). */
export interface GmgnKlineCandle {
  /** Candle open time — Unix milliseconds per the API docs. */
  time?: number | string;
  open?: number | string;
  close?: number | string;
  high?: number | string;
  low?: number | string;
  /** USD value traded. */
  volume?: number | string;
  /** Token units traded. */
  amount?: number | string;
}

/** Params for a rank scan request. */
export interface GmgnRankParams {
  chain?: string;
  interval?: string;
  order_by?: string;
  direction?: string;
  limit?: number;
  filters?: string[];
  platforms?: string[];
}
