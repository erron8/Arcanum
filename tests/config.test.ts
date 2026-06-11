import { test, expect, describe } from 'bun:test';
import { buildConfig, validateEnv } from '../src/alerts/config';

// Helper: most "valid config" cases need the fail-closed auth satisfied. Default
// to open mode so each test can focus on the field it's exercising.
const ok = (env: Record<string, string | undefined> = {}): string[] =>
  validateEnv({ ALLOW_OPEN_BOT: 'true', ...env });

describe('validateEnv', () => {
  test('clean env yields no errors', () => {
    expect(ok()).toEqual([]);
    expect(
      ok({
        POLL_INTERVAL_MS: '60000',
        DEFAULT_DRAWDOWN_THRESHOLD_PCT: '50',
        RECOVERY_HYSTERESIS_PCT: '5',
        CHART_INTERVAL: '1h',
        QUOTE: 'usd',
        ATH_WINDOW: 'all',
        FETCH_ATTEMPTS: '3',
      }),
    ).toEqual([]);
  });

  test('fails closed when neither allowlist nor ALLOW_OPEN_BOT is set', () => {
    const errs = validateEnv({});
    expect(errs.some((e) => e.includes('ALLOW_OPEN_BOT'))).toBe(true);
    // An allowlist alone satisfies it…
    expect(validateEnv({ TELEGRAM_ALLOWED_CHAT_IDS: '123' })).toEqual([]);
    // …and so does the explicit open-mode opt-in.
    expect(validateEnv({ ALLOW_OPEN_BOT: 'true' })).toEqual([]);
  });

  test('rejects zero / negative poll interval', () => {
    expect(validateEnv({ POLL_INTERVAL_MS: '0' }).length).toBeGreaterThan(0);
    expect(validateEnv({ POLL_INTERVAL_MS: '-1' }).length).toBeGreaterThan(0);
  });

  test('rejects FETCH_ATTEMPTS=0 and non-integers', () => {
    expect(validateEnv({ FETCH_ATTEMPTS: '0' }).length).toBeGreaterThan(0);
    expect(validateEnv({ FETCH_ATTEMPTS: '1.5' }).length).toBeGreaterThan(0);
  });

  test('rejects invalid interval', () => {
    const errs = validateEnv({ CHART_INTERVAL: '1h30m' });
    expect(errs.some((e) => e.includes('CHART_INTERVAL'))).toBe(true);
  });

  test('rejects invalid quote', () => {
    expect(validateEnv({ QUOTE: 'eur' }).some((e) => e.includes('QUOTE'))).toBe(true);
  });

  test('rejects threshold <= hysteresis', () => {
    const errs = validateEnv({
      DEFAULT_DRAWDOWN_THRESHOLD_PCT: '5',
      RECOVERY_HYSTERESIS_PCT: '5',
    });
    expect(errs.some((e) => e.includes('greater than'))).toBe(true);
  });

  test('rejects out-of-range threshold', () => {
    expect(validateEnv({ DEFAULT_DRAWDOWN_THRESHOLD_PCT: '0' }).length).toBeGreaterThan(0);
    expect(validateEnv({ DEFAULT_DRAWDOWN_THRESHOLD_PCT: '150' }).length).toBeGreaterThan(0);
  });

  test('rejects bad ATH_WINDOW', () => {
    expect(validateEnv({ ATH_WINDOW: 'lots' }).length).toBeGreaterThan(0);
    expect(validateEnv({ ATH_WINDOW: '-3' }).length).toBeGreaterThan(0);
    expect(ok({ ATH_WINDOW: '500' })).toEqual([]);
  });

  test('rejects malformed allowlist (never fail open)', () => {
    expect(validateEnv({ TELEGRAM_ALLOWED_CHAT_IDS: 'abc' }).length).toBeGreaterThan(0);
    expect(validateEnv({ TELEGRAM_ALLOWED_CHAT_IDS: '1, two, 3' }).length).toBeGreaterThan(0);
    expect(validateEnv({ TELEGRAM_ALLOWED_CHAT_IDS: '1.5' }).length).toBeGreaterThan(0);
    expect(validateEnv({ TELEGRAM_ALLOWED_CHAT_IDS: '1, 2, -300' })).toEqual([]); // allowlist satisfies auth
  });

  test('rejects POLL_CONCURRENCY < 1 and non-integers', () => {
    expect(validateEnv({ POLL_CONCURRENCY: '0' }).length).toBeGreaterThan(0);
    expect(validateEnv({ POLL_CONCURRENCY: '2.5' }).length).toBeGreaterThan(0);
    expect(ok({ POLL_CONCURRENCY: '8' })).toEqual([]);
  });

  test('rejects STALE_CANDLE_MULTIPLIER < 1', () => {
    expect(validateEnv({ STALE_CANDLE_MULTIPLIER: '0' }).length).toBeGreaterThan(0);
    expect(ok({ STALE_CANDLE_MULTIPLIER: '3' })).toEqual([]);
  });

  test('rejects FETCH_TIMEOUT_MS below 1000', () => {
    expect(validateEnv({ FETCH_TIMEOUT_MS: '500' }).length).toBeGreaterThan(0);
    expect(ok({ FETCH_TIMEOUT_MS: '8000' })).toEqual([]);
  });

  test('rejects identical STORE_PATH and SUBSCRIBERS_PATH', () => {
    const errs = validateEnv({ STORE_PATH: './data/x.json', SUBSCRIBERS_PATH: './data/x.json' });
    expect(errs.some((e) => e.includes('different files'))).toBe(true);
    // Relative vs absolute that resolve to the same file are also caught.
    expect(
      validateEnv({ STORE_PATH: 'data/x.json', SUBSCRIBERS_PATH: './data/x.json' }).length,
    ).toBeGreaterThan(0);
    expect(ok({ STORE_PATH: './a.json', SUBSCRIBERS_PATH: './b.json' })).toEqual([]);
  });

  test('webhook requires a secret token unless overridden', () => {
    expect(validateEnv({ WEBHOOK_URL: 'https://x/y' }).some((e) => e.includes('WEBHOOK'))).toBe(
      true,
    );
    expect(ok({ WEBHOOK_URL: 'https://x/y', WEBHOOK_SECRET_TOKEN: 's3cret' })).toEqual([]);
    expect(ok({ WEBHOOK_URL: 'https://x/y', ALLOW_INSECURE_WEBHOOK: 'true' })).toEqual([]);
  });

  test('rejects malformed TELEGRAM_CHAT_ID', () => {
    expect(validateEnv({ TELEGRAM_CHAT_ID: 'abc' }).length).toBeGreaterThan(0);
    expect(validateEnv({ TELEGRAM_CHAT_ID: '1.5' }).length).toBeGreaterThan(0);
    expect(ok({ TELEGRAM_CHAT_ID: '-1001234567890' })).toEqual([]);
  });

  test('rejects invalid WEBHOOK_PORT', () => {
    const base = { WEBHOOK_URL: 'https://x/y', WEBHOOK_SECRET_TOKEN: 's3cret' };
    expect(validateEnv({ ...base, WEBHOOK_PORT: '0' }).length).toBeGreaterThan(0);
    expect(validateEnv({ ...base, WEBHOOK_PORT: '65536' }).length).toBeGreaterThan(0);
    expect(validateEnv({ ...base, WEBHOOK_PORT: 'abc' }).length).toBeGreaterThan(0);
    expect(ok({ ...base, WEBHOOK_PORT: '8443' })).toEqual([]);
  });
});

describe('buildConfig', () => {
  test('applies defaults', () => {
    const c = buildConfig({});
    expect(c.interval).toBe('1_DAY');
    expect(c.quote).toBe('native');
    expect(c.candles).toBe(1000);
    expect(c.defaultThresholdPct).toBe(50);
    expect(c.allowedChatIds).toEqual([]);
    expect(c.telegramChatId).toBeUndefined();
    expect(c.webhookUrl).toBeUndefined();
    expect(c.webhookPort).toBe(8080);
  });

  test('normalizes interval aliases and parses allowlist', () => {
    const c = buildConfig({ CHART_INTERVAL: '1h', TELEGRAM_ALLOWED_CHAT_IDS: '1, 2 3' });
    expect(c.interval).toBe('1_HOUR');
    expect(c.allowedChatIds).toEqual([1, 2, 3]);
  });

  test('ATH_WINDOW numeric overrides candle count', () => {
    expect(buildConfig({ ATH_WINDOW: '250' }).candles).toBe(250);
  });

  test('captures webhook URL and port', () => {
    const c = buildConfig({ WEBHOOK_URL: ' https://example.com/hook ', WEBHOOK_PORT: '8443' });
    expect(c.webhookUrl).toBe('https://example.com/hook');
    expect(c.webhookPort).toBe(8443);
  });

  test('captures TELEGRAM_CHAT_ID', () => {
    expect(buildConfig({ TELEGRAM_CHAT_ID: '-1001234567890' }).telegramChatId).toBe(
      -1001234567890,
    );
    expect(buildConfig({ TELEGRAM_CHAT_ID: 'bad' }).telegramChatId).toBeUndefined();
  });

  test('GMGN scanner is disabled by default with sane defaults', () => {
    const g = buildConfig({}).gmgn;
    expect(g.enabled).toBe(false);
    expect(g.autoWatch).toBe(false);
    expect(g.apiKey).toBe('');
    expect(g.scanIntervalMs).toBe(300_000);
    expect(g.totalFeeMinSol).toBe(30);
    expect(g.marketCapMinUsd).toBe(250_000);
    expect(g.drawdownMinPct).toBe(50);
    expect(g.minTokenAgeHours).toBe(4);
    expect(g.maxTokenAgeDays).toBe(14);
    expect(g.scanLimit).toBe(100);
    expect(g.scanConcurrency).toBe(4);
    expect(g.dedupeMs).toBe(86_400_000);
    expect(g.baseUrl).toBe('https://openapi.gmgn.ai');
  });

  test('GMGN flags parse from env', () => {
    const g = buildConfig({ GMGN_SCAN_ENABLED: 'true', GMGN_AUTO_WATCH: 'true', GMGN_API_KEY: ' k ' }).gmgn;
    expect(g.enabled).toBe(true);
    expect(g.autoWatch).toBe(true);
    expect(g.apiKey).toBe('k'); // trimmed
  });
});

describe('validateEnv GMGN', () => {
  test('unset GMGN section is valid (defaults pass)', () => {
    expect(ok()).toEqual([]);
  });

  test('GMGN_API_KEY is required only when the scanner is enabled', () => {
    expect(ok({ GMGN_SCAN_ENABLED: 'true' }).some((e) => e.includes('GMGN_API_KEY'))).toBe(true);
    expect(ok({ GMGN_SCAN_ENABLED: 'true', GMGN_API_KEY: 'secret' })).toEqual([]);
    // Disabled scanner needs no key.
    expect(ok({ GMGN_SCAN_ENABLED: 'false' })).toEqual([]);
  });

  test('scan interval must be >= 60000', () => {
    expect(ok({ GMGN_SCAN_INTERVAL_MS: '1000' }).length).toBeGreaterThan(0);
    expect(ok({ GMGN_SCAN_INTERVAL_MS: '60000' })).toEqual([]);
  });

  test('concurrency must be in [1, 32]', () => {
    expect(ok({ GMGN_SCAN_CONCURRENCY: '0' }).length).toBeGreaterThan(0);
    expect(ok({ GMGN_SCAN_CONCURRENCY: '64' }).length).toBeGreaterThan(0);
    expect(ok({ GMGN_SCAN_CONCURRENCY: '8' })).toEqual([]);
  });

  test('scan limit must be in [1, 100]', () => {
    expect(ok({ GMGN_SCAN_LIMIT: '0' }).length).toBeGreaterThan(0);
    expect(ok({ GMGN_SCAN_LIMIT: '101' }).length).toBeGreaterThan(0);
    expect(ok({ GMGN_SCAN_LIMIT: '50' })).toEqual([]);
  });

  test('drawdown must be in [0, 100] and numerics finite', () => {
    expect(ok({ GMGN_DRAWDOWN_MIN_PCT: '150' }).length).toBeGreaterThan(0);
    expect(ok({ GMGN_TOTAL_FEE_MIN_SOL: 'abc' }).length).toBeGreaterThan(0);
    expect(ok({ GMGN_MARKET_CAP_MIN_USD: '-1' }).length).toBeGreaterThan(0);
  });

  test('min age must be below max age', () => {
    expect(
      ok({ GMGN_MIN_TOKEN_AGE_HOURS: '400', GMGN_MAX_TOKEN_AGE_DAYS: '14' }).some((e) =>
        e.includes('less than'),
      ),
    ).toBe(true);
  });
});
