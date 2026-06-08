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

  return errors;
}
