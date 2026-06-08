import { test, expect, describe } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertStore } from '../src/alerts/store';
import { AthMonitor } from '../src/alerts/athMonitor';
import type { ChartFetcher } from '../src/alerts/athMonitor';
import { TelegramTransport } from '../src/alerts/telegramBot';
import { buildConfig } from '../src/alerts/config';
import type { AppConfig } from '../src/alerts/config';
import type { ChartDataPoint, AlertPayload } from '../src/models/types';
import type { Update } from 'grammy/types';

function tmpFile(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

/** Candle fetcher whose last point yields a given price + rolling ATH. */
function fetcherWith(price: number, athPrice: number): ChartFetcher {
  return async () =>
    [
      {
        time: Date.now(),
        open: price,
        high: athPrice,
        low: price,
        close: price,
        volume: 0,
        athPrice,
      } as ChartDataPoint,
    ];
}

const emptyFetcher: ChartFetcher = async () => [];

function payload(mint: string): AlertPayload {
  return {
    mint,
    symbol: 'TKN',
    price: 1,
    ath: 2,
    drawdownPct: 50,
    threshold: 40,
    jupiterUrl: `https://jup.ag/tokens/${mint}`,
    birdeyeUrl: `https://birdeye.so/token/${mint}?chain=solana`,
  };
}

async function makeTransport(
  cfgOverrides: Partial<AppConfig>,
  subscribers: number[],
  fetcher: ChartFetcher = emptyFetcher,
  symbol: string | undefined = undefined,
): Promise<{ bot: TelegramTransport; store: AlertStore; subsPath: string }> {
  const subsPath = tmpFile('subs');
  await fs.writeFile(subsPath, JSON.stringify(subscribers), 'utf8');
  const cfg: AppConfig = {
    ...buildConfig({}),
    subscribersPath: subsPath,
    sendIntervalMs: 0,
    ...cfgOverrides,
  };
  const store = new AlertStore(tmpFile('store'), { flushDelayMs: 9999, writer: async () => {} });
  await store.init();
  const monitor = new AthMonitor(store, cfg, fetcher);
  // Inject a symbol stub so command tests never hit the network.
  const bot = new TelegramTransport('111:FAKE', store, monitor, cfg, {
    fetchSymbol: async () => symbol,
  });
  return { bot, store, subsPath };
}

const ok = { ok: true, result: { message_id: 1, date: 0, chat: { id: 0, type: 'private' } } };
const getMeResult = {
  ok: true,
  result: {
    id: 1,
    is_bot: true,
    first_name: 'Test',
    username: 'testbot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  },
};
const apiErr = (code: number, params?: Record<string, unknown>) => ({
  ok: false,
  error_code: code,
  description: `error ${code}`,
  parameters: params ?? {},
});

/** Records outgoing sendMessage calls and answers getMe so handleUpdate works offline. */
function recorder(bot: TelegramTransport): Array<{ chatId: number; text: string }> {
  const sent: Array<{ chatId: number; text: string }> = [];
  bot.useApiInterceptor((method, p) => {
    if (method === 'getMe') return getMeResult;
    if (method === 'sendMessage') sent.push({ chatId: Number(p.chat_id), text: String(p.text) });
    return ok;
  });
  return sent;
}

function cmdUpdate(chatId: number, text: string): Update {
  const cmd = text.split(' ')[0]!;
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'U' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: cmd.length }],
    },
  } as unknown as Update;
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const MINT = 'So11111111111111111111111111111111111111112';

describe('TelegramTransport subscriber authorization', () => {
  test('prunes unauthorized subscribers on init when allowlist is set', async () => {
    const { bot, subsPath } = await makeTransport({ allowedChatIds: [1, 2] }, [1, 2, 3, 999]);
    await bot.init();
    expect(bot.subscriberIds().sort((a, b) => a - b)).toEqual([1, 2]);

    // The pruned set must be persisted so the prune survives a restart.
    const persisted = JSON.parse(await fs.readFile(subsPath, 'utf8')) as number[];
    expect(persisted.sort((a, b) => a - b)).toEqual([1, 2]);
    await fs.rm(subsPath, { force: true });
  });

  test('keeps all subscribers when allowlist is empty (open mode)', async () => {
    const { bot, subsPath } = await makeTransport({ allowedChatIds: [] }, [5, 6]);
    await bot.init();
    expect(bot.subscriberIds().sort((a, b) => a - b)).toEqual([5, 6]);
    await fs.rm(subsPath, { force: true });
  });

  test('drops an unauthorized TELEGRAM_CHAT_ID seed', async () => {
    const { bot, subsPath } = await makeTransport({ allowedChatIds: [1], telegramChatId: 777 }, [1]);
    await bot.init();
    expect(bot.subscriberIds()).toEqual([1]);
    await fs.rm(subsPath, { force: true });
  });
});

describe('TelegramTransport /watch', () => {
  test('persists only after live verification succeeds', async () => {
    const { bot, store } = await makeTransport({}, [], fetcherWith(50, 100));
    const sent: string[] = [];
    bot.useApiInterceptor((_m, p) => {
      sent.push(String(p.text));
      return ok;
    });
    await bot.processWatch(1, MINT, 40);
    expect(store.has(MINT)).toBe(true);
    expect(store.get(MINT)!.threshold).toBe(40);
    expect(store.get(MINT)!.persistedAth).toBe(100);
    expect(sent.some((t) => t.includes('Watching'))).toBe(true);
  });

  test('does NOT persist a mint with no market data', async () => {
    const { bot, store } = await makeTransport({}, [], emptyFetcher);
    const sent: string[] = [];
    bot.useApiInterceptor((_m, p) => {
      sent.push(String(p.text));
      return ok;
    });
    await bot.processWatch(1, MINT, 40);
    expect(store.has(MINT)).toBe(false);
    expect(sent.some((t) => t.includes('not'))).toBe(true);
  });

  test('re-watch in a different quote rebases ATH (end-to-end)', async () => {
    const { bot, store } = await makeTransport({ quote: 'native' }, [], fetcherWith(50, 100));
    bot.useApiInterceptor(() => ok);
    // Pre-existing USD watch with a stale-denomination ATH.
    store.upsertWatch(MINT, 40);
    store.updatePersistedAth(MINT, 1000, 'usd');
    await bot.processWatch(1, MINT, 40);
    expect(store.get(MINT)!.quote).toBe('native');
    expect(store.get(MINT)!.persistedAth).toBe(100); // not stuck at 1000
  });
});

describe('TelegramTransport delivery (confirmed)', () => {
  test('accepts mints only after successful delivery to an authorized subscriber', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [1] }, [1]);
    await bot.init();
    bot.useApiInterceptor(() => ok);
    const accepted = await bot.buildSink()([payload('m1')]);
    expect(accepted).toEqual(['m1']);
  });

  test('accepts nothing when there are no subscribers (stays ARMED)', async () => {
    const { bot } = await makeTransport({}, []);
    await bot.init();
    const accepted = await bot.buildSink()([payload('m1')]);
    expect(accepted).toEqual([]);
  });

  test('a 5xx/network failure is NOT accepted (alert will retry)', async () => {
    const { bot } = await makeTransport({}, [42]);
    await bot.init();
    bot.useApiInterceptor(() => apiErr(500));
    const accepted = await bot.buildSink()([payload('m1')]);
    expect(accepted).toEqual([]); // not delivered → not consumed
    expect(bot.subscriberIds()).toEqual([42]); // 5xx doesn't drop the subscriber
  });

  test('a 403 removes the dead subscriber and is not accepted', async () => {
    const { bot } = await makeTransport({}, [42]);
    await bot.init();
    bot.useApiInterceptor(() => apiErr(403));
    const accepted = await bot.buildSink()([payload('m1')]);
    expect(accepted).toEqual([]);
    expect(bot.subscriberIds()).toEqual([]);
  });

  test('a 429 is retried (not dropped) and eventually delivered', async () => {
    const { bot } = await makeTransport({}, [42]);
    await bot.init();
    let calls = 0;
    bot.useApiInterceptor((m) => {
      if (m !== 'sendMessage') return ok;
      calls++;
      return calls === 1 ? apiErr(429, { retry_after: 0 }) : ok;
    });
    const accepted = await bot.buildSink()([payload('m1')]);
    expect(calls).toBe(2); // first 429, then success
    expect(accepted).toEqual(['m1']);
    expect(bot.subscriberIds()).toEqual([42]);
  });

  test('a subscriber who /stop’d mid-delivery does not receive the alert', async () => {
    const { bot } = await makeTransport({}, [42, 43]);
    await bot.init();
    const sentTo: number[] = [];
    bot.useApiInterceptor((m, p) => {
      if (m !== 'sendMessage') return ok;
      const chat = Number(p.chat_id);
      sentTo.push(chat);
      if (chat === 42) bot.unsubscribe(43); // 43 leaves before its turn
      return ok;
    });
    await bot.buildSink()([payload('m1')]);
    expect(sentTo).toEqual([42]); // 43 skipped by the membership recheck
  });
});

describe('TelegramTransport commands (real handler path)', () => {
  test('/watch verifies, persists, and confirms', async () => {
    const { bot, store } = await makeTransport(
      { allowedChatIds: [7] },
      [],
      fetcherWith(50, 100),
      'WSOL',
    );
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, `/watch ${MINT} 60`));
    await waitUntil(() => store.has(MINT));
    expect(store.get(MINT)!.threshold).toBe(60);
    expect(store.get(MINT)!.symbol).toBe('WSOL');
    expect(store.get(MINT)!.persistedAth).toBe(100);
    await waitUntil(() => sent.some((m) => m.text.includes('Watching')));
  });

  test('/watch rejects an invalid mint without touching the store', async () => {
    const { bot, store } = await makeTransport({ allowedChatIds: [7] }, [], fetcherWith(50, 100));
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/watch not-a-mint'));
    expect(store.has('not-a-mint')).toBe(false);
    expect(sent.some((m) => m.text.includes('base58'))).toBe(true);
  });

  test('/status replies with current price/drawdown', async () => {
    const { bot, store } = await makeTransport({ allowedChatIds: [7] }, [], fetcherWith(50, 100));
    store.upsertWatch(MINT, 40);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, `/status ${MINT}`));
    await waitUntil(() => sent.some((m) => m.text.includes('Status')));
  });

  test('/list shows watched tokens', async () => {
    const { bot, store } = await makeTransport({ allowedChatIds: [7] }, []);
    store.upsertWatch(MINT, 40);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/list'));
    expect(sent.some((m) => m.text.includes('Watched tokens'))).toBe(true);
  });

  test('/stop unsubscribes the chat', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, [7]);
    await bot.init();
    expect(bot.subscriberIds()).toContain(7);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/stop'));
    expect(bot.subscriberIds()).not.toContain(7);
    expect(sent.some((m) => m.text.includes('unsubscribed'))).toBe(true);
  });

  test('an unauthorized chat is rejected and cannot mutate the store', async () => {
    const { bot, store } = await makeTransport({ allowedChatIds: [7] }, [], fetcherWith(50, 100));
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(8, `/watch ${MINT} 60`));
    // give any (incorrect) async processing a chance to run
    await new Promise((r) => setTimeout(r, 30));
    expect(store.has(MINT)).toBe(false);
    expect(sent.some((m) => m.text.includes('not authorized'))).toBe(true);
  });
});
