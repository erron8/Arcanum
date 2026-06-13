import { resolve } from 'node:path';
import { JUPITER_INTERVALS, normalizeInterval } from '../fetchers/chartData';
import { parseChatIds } from './auth';

type Env = Record<string, string | undefined>;

function rawNum(env: Env, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function rawStr(env: Env, name: string, def: string): string {
  const v = env[name];
  return v === undefined || v.trim() === '' ? def : v;
}

/** Parse a boolean env flag. Only the literal string 'true' enables it. */
function rawBool(env: Env, name: string, def: boolean): boolean {
  const v = env[name];
  if (v === undefined || v.trim() === '') return def;
  return v.trim().toLowerCase() === 'true';
}

/**
 * ATH_WINDOW controls how many candles define the lookback window.
 *   'all'  → request ATH_MAX_CANDLES candles.
 *   <num>  → that many candles.
 */
function resolveCandles(window: string, max: number): number {
  if (window.toLowerCase() === 'all') return max;
  const n = Number(window);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : max;
}

/** Default GMGN OpenAPI base URL; overridable via GMGN_BASE_URL (mainly for tests). */
export const GMGN_DEFAULT_BASE_URL = 'https://openapi.gmgn.ai';

/** Hard cap on scan concurrency so a misconfigured value can't hammer the API. */
export const GMGN_MAX_CONCURRENCY = 32;

/** Default Meteora DLMM Data API base URL; overridable via METEORA_BASE_URL. */
export const METEORA_DEFAULT_BASE_URL = 'https://dlmm.datapi.meteora.ag';

/**
 * Configuration for the optional Meteora DLMM pool links added to alert messages.
 * Enabled by default (public API, no key); best-effort — failures never block alerts.
 */
export interface MeteoraConfig {
  enabled: boolean;
  baseUrl: string;
  /** Max pool links shown per alert (top pools by 24h volume). */
  maxPools: number;
  attempts: number;
  backoffMs: number;
  timeoutMs: number;
}

/**
 * Configuration for the optional GMGN drawdown scanner. The scanner is disabled
 * by default and never affects the existing /watch flow.
 */
export interface GmgnConfig {
  enabled: boolean;
  apiKey: string; // empty when disabled; required (validated) when enabled
  baseUrl: string;
  scanIntervalMs: number;
  totalFeeMinSol: number;
  marketCapMinUsd: number;
  drawdownMinPct: number;
  minTokenAgeHours: number;
  maxTokenAgeDays: number;
  scanLimit: number;
  scanConcurrency: number;
  dedupeMs: number;
  autoWatch: boolean;
  screenedPath: string;
  // request resilience (shared defaults with the Jupiter fetch tunables)
  attempts: number;
  backoffMs: number;
  timeoutMs: number;
}

export interface AppConfig {
  defaultThresholdPct: number;
  pollIntervalMs: number;
  athWindow: string;
  alertCooldownMs: number;
  recoveryHysteresisPct: number;
  quote: 'native' | 'usd';
  interval: string;
  candles: number;
  storePath: string;
  subscribersPath: string;
  flushDelayMs: number;
  sendIntervalMs: number;
  fetchAttempts: number;
  fetchBackoffMs: number;
  fetchTimeoutMs: number;
  pollConcurrency: number;
  staleCandleMultiplier: number;
  allowedChatIds: number[];
  telegramChatId: number | undefined;
  webhookUrl: string | undefined;
  webhookPort: number;
  webhookSecret: string | undefined;
  gmgn: GmgnConfig;
  meteora: MeteoraConfig;
}

/** Build the Meteora sub-config from the environment (pure; defaults for blanks). */
function buildMeteoraConfig(env: Env): MeteoraConfig {
  return {
    enabled: rawBool(env, 'METEORA_LINKS_ENABLED', true),
    baseUrl: rawStr(env, 'METEORA_BASE_URL', METEORA_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    maxPools: rawNum(env, 'METEORA_MAX_POOLS', 5),
    attempts: rawNum(env, 'FETCH_ATTEMPTS', 3),
    backoffMs: rawNum(env, 'FETCH_BACKOFF_MS', 500),
    timeoutMs: rawNum(env, 'FETCH_TIMEOUT_MS', 8_000),
  };
}

/** Build the GMGN sub-config from the environment (pure; defaults for blanks). */
function buildGmgnConfig(env: Env): GmgnConfig {
  return {
    enabled: rawBool(env, 'GMGN_SCAN_ENABLED', false),
    apiKey: rawStr(env, 'GMGN_API_KEY', '').trim(),
    baseUrl: rawStr(env, 'GMGN_BASE_URL', GMGN_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    scanIntervalMs: rawNum(env, 'GMGN_SCAN_INTERVAL_MS', 300_000),
    totalFeeMinSol: rawNum(env, 'GMGN_TOTAL_FEE_MIN_SOL', 30),
    marketCapMinUsd: rawNum(env, 'GMGN_MARKET_CAP_MIN_USD', 250_000),
    drawdownMinPct: rawNum(env, 'GMGN_DRAWDOWN_MIN_PCT', 50),
    minTokenAgeHours: rawNum(env, 'GMGN_MIN_TOKEN_AGE_HOURS', 4),
    maxTokenAgeDays: rawNum(env, 'GMGN_MAX_TOKEN_AGE_DAYS', 14),
    scanLimit: rawNum(env, 'GMGN_SCAN_LIMIT', 100),
    scanConcurrency: rawNum(env, 'GMGN_SCAN_CONCURRENCY', 4),
    dedupeMs: rawNum(env, 'GMGN_DEDUPE_MS', 86_400_000),
    autoWatch: rawBool(env, 'GMGN_AUTO_WATCH', false),
    screenedPath: rawStr(env, 'GMGN_SCREENED_PATH', './data/gmgn-screened.json'),
    // Reuse the Jupiter fetch tunables as sensible defaults for the GMGN client.
    attempts: rawNum(env, 'FETCH_ATTEMPTS', 3),
    backoffMs: rawNum(env, 'FETCH_BACKOFF_MS', 500),
    timeoutMs: rawNum(env, 'FETCH_TIMEOUT_MS', 8_000),
  };
}

/** Build a config snapshot from an environment map (pure; defaults for blanks). */
export function buildConfig(env: Env): AppConfig {
  const athWindow = rawStr(env, 'ATH_WINDOW', 'all');
  const athMaxCandles = rawNum(env, 'ATH_MAX_CANDLES', 1000);
  const normalized = normalizeInterval(rawStr(env, 'CHART_INTERVAL', '1_DAY'));

  return {
    defaultThresholdPct: rawNum(env, 'DEFAULT_DRAWDOWN_THRESHOLD_PCT', 50),
    pollIntervalMs: rawNum(env, 'POLL_INTERVAL_MS', 60_000),
    athWindow,
    alertCooldownMs: rawNum(env, 'ALERT_COOLDOWN_MS', 30 * 60_000),
    recoveryHysteresisPct: rawNum(env, 'RECOVERY_HYSTERESIS_PCT', 5),
    quote: rawStr(env, 'QUOTE', 'native') === 'usd' ? 'usd' : 'native',
    // Fall back to a valid default if the configured interval is unknown; validateEnv reports it.
    interval: normalized ?? '1_DAY',
    candles: resolveCandles(athWindow, athMaxCandles),
    storePath: rawStr(env, 'STORE_PATH', './data/alerts.json'),
    subscribersPath: rawStr(env, 'SUBSCRIBERS_PATH', './data/subscribers.json'),
    flushDelayMs: rawNum(env, 'STORE_FLUSH_DELAY_MS', 1_000),
    sendIntervalMs: rawNum(env, 'SEND_INTERVAL_MS', 60), // well under Telegram's ~30 msg/s
    fetchAttempts: rawNum(env, 'FETCH_ATTEMPTS', 3),
    fetchBackoffMs: rawNum(env, 'FETCH_BACKOFF_MS', 500),
    fetchTimeoutMs: rawNum(env, 'FETCH_TIMEOUT_MS', 8_000),
    pollConcurrency: rawNum(env, 'POLL_CONCURRENCY', 4),
    staleCandleMultiplier: rawNum(env, 'STALE_CANDLE_MULTIPLIER', 3),
    allowedChatIds: parseChatIds(env.TELEGRAM_ALLOWED_CHAT_IDS),
    telegramChatId:
      env.TELEGRAM_CHAT_ID !== undefined &&
      env.TELEGRAM_CHAT_ID.trim() !== '' &&
      Number.isFinite(Number(env.TELEGRAM_CHAT_ID)) &&
      Number.isInteger(Number(env.TELEGRAM_CHAT_ID))
        ? Number(env.TELEGRAM_CHAT_ID)
        : undefined,
    webhookUrl: env.WEBHOOK_URL?.trim() || undefined,
    webhookPort: rawNum(env, 'WEBHOOK_PORT', 8080),
    webhookSecret: env.WEBHOOK_SECRET_TOKEN?.trim() || undefined,
    gmgn: buildGmgnConfig(env),
    meteora: buildMeteoraConfig(env),
  };
}

/**
 * Validate the environment by domain. Returns a list of human-readable errors;
 * empty means OK. Pure — used by the bootstrap to fail fast.
 */
export function validateEnv(env: Env): string[] {
  const errors: string[] = [];

  const requirePositive = (name: string, def: number, min: number): number => {
    const v = env[name];
    const n = v === undefined || v.trim() === '' ? def : Number(v);
    if (!Number.isFinite(n) || n < min) {
      errors.push(`${name} must be a number >= ${min} (got '${v ?? '(unset)'}').`);
    }
    return n;
  };

  const requireInt = (name: string, def: number, min: number): number => {
    const v = env[name];
    const n = v === undefined || v.trim() === '' ? def : Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
      errors.push(`${name} must be an integer >= ${min} (got '${v ?? '(unset)'}').`);
    }
    return n;
  };

  const requireRange = (name: string, def: number, lo: number, hi: number): number => {
    const v = env[name];
    const n = v === undefined || v.trim() === '' ? def : Number(v);
    if (!Number.isFinite(n) || n <= lo || n > hi) {
      errors.push(`${name} must be in (${lo}, ${hi}] (got '${v ?? '(unset)'}').`);
    }
    return n;
  };

  requirePositive('POLL_INTERVAL_MS', 60_000, 1_000);
  requirePositive('ALERT_COOLDOWN_MS', 30 * 60_000, 0);
  requirePositive('FETCH_BACKOFF_MS', 500, 0);
  requirePositive('STORE_FLUSH_DELAY_MS', 1_000, 0);
  requirePositive('SEND_INTERVAL_MS', 60, 0);
  requireInt('FETCH_ATTEMPTS', 3, 1);
  requireInt('ATH_MAX_CANDLES', 1000, 1);
  requirePositive('FETCH_TIMEOUT_MS', 8_000, 1_000);
  requireInt('POLL_CONCURRENCY', 4, 1);
  requirePositive('STALE_CANDLE_MULTIPLIER', 3, 1);

  const threshold = requireRange('DEFAULT_DRAWDOWN_THRESHOLD_PCT', 50, 0, 100);

  // hysteresis: [0, 100); also must be strictly below the default threshold.
  const hRaw = env.RECOVERY_HYSTERESIS_PCT;
  const hyst = hRaw === undefined || hRaw.trim() === '' ? 5 : Number(hRaw);
  if (!Number.isFinite(hyst) || hyst < 0 || hyst >= 100) {
    errors.push(`RECOVERY_HYSTERESIS_PCT must be in [0, 100) (got '${hRaw ?? '(unset)'}').`);
  } else if (Number.isFinite(threshold) && hyst >= threshold) {
    errors.push(
      `DEFAULT_DRAWDOWN_THRESHOLD_PCT (${threshold}) must be greater than ` +
        `RECOVERY_HYSTERESIS_PCT (${hyst}), otherwise alerts can never re-arm.`,
    );
  }

  const interval = env.CHART_INTERVAL;
  if (interval !== undefined && interval.trim() !== '' && normalizeInterval(interval) === null) {
    errors.push(`CHART_INTERVAL '${interval}' is invalid. Valid: ${JUPITER_INTERVALS.join(', ')}.`);
  }

  const quote = env.QUOTE;
  if (quote !== undefined && quote.trim() !== '' && quote !== 'native' && quote !== 'usd') {
    errors.push(`QUOTE must be 'native' or 'usd' (got '${quote}').`);
  }

  // Store and subscribers must never resolve to the same file, or one would
  // overwrite the other.
  const storePath = rawStr(env, 'STORE_PATH', './data/alerts.json');
  const subsPath = rawStr(env, 'SUBSCRIBERS_PATH', './data/subscribers.json');
  if (resolve(storePath) === resolve(subsPath)) {
    errors.push(
      `STORE_PATH and SUBSCRIBERS_PATH must point to different files (both resolve to '${resolve(storePath)}').`,
    );
  }

  const window = env.ATH_WINDOW;
  if (window !== undefined && window.trim() !== '' && window.toLowerCase() !== 'all') {
    const n = Number(window);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      errors.push(`ATH_WINDOW must be 'all' or a positive integer (got '${window}').`);
    }
  }

  const envChat = env.TELEGRAM_CHAT_ID;
  if (envChat !== undefined && envChat.trim() !== '') {
    const n = Number(envChat);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      errors.push(`TELEGRAM_CHAT_ID must be an integer chat id (got '${envChat}').`);
    }
  }

  // Allowlist: if set, every token must be a valid integer chat id — never fail open.
  const rawAllow = env.TELEGRAM_ALLOWED_CHAT_IDS;
  const allowSet = rawAllow !== undefined && rawAllow.trim() !== '';
  if (allowSet) {
    const tokens = rawAllow.split(/[,\s]+/).filter((t) => t !== '');
    const bad = tokens.filter((t) => {
      const n = Number(t);
      return !Number.isFinite(n) || !Number.isInteger(n);
    });
    if (tokens.length === 0 || bad.length > 0) {
      errors.push(
        `TELEGRAM_ALLOWED_CHAT_IDS contains invalid chat id(s): ` +
          `${bad.length > 0 ? bad.join(', ') : '(none parseable)'}. ` +
          `Use comma/space-separated integers, or unset it and set ALLOW_OPEN_BOT=true.`,
      );
    }
  } else if (env.ALLOW_OPEN_BOT !== 'true') {
    // Fail closed: refuse to run an unauthenticated (open) bot unless explicitly allowed.
    errors.push(
      'No TELEGRAM_ALLOWED_CHAT_IDS set. Set an allowlist of chat ids, or set ' +
        'ALLOW_OPEN_BOT=true to explicitly run an OPEN bot that anyone can control.',
    );
  }

  // Webhook: require a secret token (or an explicit unsafe override) to avoid
  // accepting forged, unauthenticated update POSTs.
  if (env.WEBHOOK_URL !== undefined && env.WEBHOOK_URL.trim() !== '') {
    const rawPort = env.WEBHOOK_PORT;
    if (rawPort !== undefined && rawPort.trim() !== '') {
      const port = Number(rawPort);
      if (!Number.isFinite(port) || !Number.isInteger(port) || port < 1 || port > 65_535) {
        errors.push(`WEBHOOK_PORT must be an integer in [1, 65535] (got '${rawPort}').`);
      }
    }

    const hasSecret = !!env.WEBHOOK_SECRET_TOKEN && env.WEBHOOK_SECRET_TOKEN.trim() !== '';
    const override = env.ALLOW_INSECURE_WEBHOOK === 'true';
    if (!hasSecret && !override) {
      errors.push(
        'WEBHOOK_URL is set but WEBHOOK_SECRET_TOKEN is missing. Set a secret token, ' +
          'or set ALLOW_INSECURE_WEBHOOK=true to explicitly accept unauthenticated webhook POSTs.',
      );
    }
  }

  validateGmgnEnv(env, errors, { requirePositive, requireRange, requireInt });

  // Meteora pool links: bound the per-alert link count.
  const maxPools = requireInt('METEORA_MAX_POOLS', 5, 1);
  if (Number.isFinite(maxPools) && maxPools > 10) {
    errors.push(`METEORA_MAX_POOLS must be in [1, 10] (got '${env.METEORA_MAX_POOLS}').`);
  }

  return errors;
}

/**
 * Validate the GMGN scanner configuration. Numeric tunables are always range-checked
 * (their defaults are valid, so an unset GMGN section never produces errors). The API
 * key is required only when GMGN_SCAN_ENABLED=true, so disabling the scanner needs no key.
 */
function validateGmgnEnv(
  env: Env,
  errors: string[],
  v: {
    requirePositive: (name: string, def: number, min: number) => number;
    requireRange: (name: string, def: number, lo: number, hi: number) => number;
    requireInt: (name: string, def: number, min: number) => number;
  },
): void {
  const enabled = rawBool(env, 'GMGN_SCAN_ENABLED', false);

  if (enabled) {
    const key = env.GMGN_API_KEY;
    if (key === undefined || key.trim() === '') {
      errors.push('GMGN_API_KEY is required when GMGN_SCAN_ENABLED=true.');
    }
  }

  // Scan interval must never tick faster than once a minute, regardless of enablement.
  v.requirePositive('GMGN_SCAN_INTERVAL_MS', 300_000, 60_000);
  v.requirePositive('GMGN_TOTAL_FEE_MIN_SOL', 30, 0);
  v.requirePositive('GMGN_MARKET_CAP_MIN_USD', 250_000, 0);
  v.requireRange('GMGN_DRAWDOWN_MIN_PCT', 50, 0, 100);
  v.requirePositive('GMGN_MIN_TOKEN_AGE_HOURS', 4, 0);
  v.requirePositive('GMGN_MAX_TOKEN_AGE_DAYS', 14, 0);
  v.requireInt('GMGN_DEDUPE_MS', 86_400_000, 0);

  // rank endpoint returns at most 100 rows.
  const limit = v.requireInt('GMGN_SCAN_LIMIT', 100, 1);
  if (Number.isFinite(limit) && limit > 100) {
    errors.push(`GMGN_SCAN_LIMIT must be in [1, 100] (got '${env.GMGN_SCAN_LIMIT}').`);
  }

  const concurrency = v.requireInt('GMGN_SCAN_CONCURRENCY', 4, 1);
  if (Number.isFinite(concurrency) && concurrency > GMGN_MAX_CONCURRENCY) {
    errors.push(
      `GMGN_SCAN_CONCURRENCY must be in [1, ${GMGN_MAX_CONCURRENCY}] (got '${env.GMGN_SCAN_CONCURRENCY}').`,
    );
  }

  // The min/max age window must be coherent (min strictly below max).
  const minH = env.GMGN_MIN_TOKEN_AGE_HOURS;
  const maxD = env.GMGN_MAX_TOKEN_AGE_DAYS;
  const minHours = minH === undefined || minH.trim() === '' ? 4 : Number(minH);
  const maxDays = maxD === undefined || maxD.trim() === '' ? 14 : Number(maxD);
  if (
    Number.isFinite(minHours) &&
    Number.isFinite(maxDays) &&
    minHours / 24 >= maxDays
  ) {
    errors.push(
      `GMGN_MIN_TOKEN_AGE_HOURS (${minHours}h) must be less than ` +
        `GMGN_MAX_TOKEN_AGE_DAYS (${maxDays}d).`,
    );
  }
}
