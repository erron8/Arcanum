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
import type { Update, BotCommand } from 'grammy/types';

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
  enrichTimeoutMs: number | undefined = undefined,
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
    enrichTimeoutMs,
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
/** /testalert renders for wrapped SOL. */
const SOL_MINT_FOR_TEST = 'So11111111111111111111111111111111111111112';

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

  test('watch alert renders the rich layout, enriched by GMGN when wired', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [1] }, [1]);
    await bot.init();
    const sent = recorder(bot);
    bot.setGmgnEnricher(async () => ({
      symbol: 'WIF',
      platform: 'Pump',
      fdvUsd: 980_000,
      liquidityUsd: 120_000,
      holderCount: 4321,
    }));
    await bot.buildSink()([payload('m1')]);
    const msg = sent.map((s) => s.text).join('\n');
    expect(msg).toContain('ATH Drawdown Alert'); // watch framing preserved
    expect(msg).toContain('FDV'); // enriched field present
    expect(msg).toContain('Holders: 4321');
  });

  test('watch alert still sends (basic view) when enrichment throws', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [1] }, [1]);
    await bot.init();
    const sent = recorder(bot);
    bot.setGmgnEnricher(async () => {
      throw new Error('gmgn down');
    });
    const accepted = await bot.buildSink()([payload('m1')]);
    expect(accepted).toEqual(['m1']); // delivered despite enrichment failure
    expect(sent.map((s) => s.text).join('\n')).toContain('ATH Drawdown Alert');
  });

  test('slow enrichment does not delay the alert (bounded by enrichTimeoutMs)', async () => {
    // Tiny 20ms timeout; enricher/linker that never resolve. The alert must still
    // send promptly as the basic view (no enriched FDV / Meteora line).
    const { bot } = await makeTransport({ allowedChatIds: [1] }, [1], emptyFetcher, undefined, 20);
    await bot.init();
    const sent = recorder(bot);
    bot.setGmgnEnricher(() => new Promise(() => {})); // never resolves
    bot.setMeteoraLinker(() => new Promise(() => {})); // never resolves
    const started = Date.now();
    const accepted = await bot.buildSink()([payload('m1')]);
    const elapsed = Date.now() - started;
    expect(accepted).toEqual(['m1']); // delivered despite hanging enrichment
    expect(elapsed).toBeLessThan(1000); // not blocked on the hung promises
    const msg = sent.map((s) => s.text).join('\n');
    expect(msg).toContain('ATH Drawdown Alert');
    expect(msg).not.toContain('FDV'); // enrichment timed out → basic view
    expect(msg).not.toContain('Meteora'); // linker timed out → no pool line
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

describe('TelegramTransport.notify (generic notification path)', () => {
  test('delivers messages to authorized subscribers and reports success', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [1, 2] }, [1, 2]);
    await bot.init();
    const sent = recorder(bot);
    const ok = await bot.notify(['hello *world*']);
    expect(ok).toBe(true);
    expect(sent.filter((m) => m.text === 'hello *world*').map((m) => m.chatId).sort()).toEqual([
      1, 2,
    ]);
  });

  test('reports false when there are no subscribers (will retry)', async () => {
    const { bot } = await makeTransport({}, []);
    await bot.init();
    expect(await bot.notify(['x'])).toBe(false);
  });

  test('a 5xx is not counted as delivered', async () => {
    const { bot } = await makeTransport({}, [42]);
    await bot.init();
    bot.useApiInterceptor(() => apiErr(500));
    expect(await bot.notify(['x'])).toBe(false);
  });

  test('empty message list is a no-op', async () => {
    const { bot } = await makeTransport({}, [42]);
    await bot.init();
    expect(await bot.notify([])).toBe(false);
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

  test('/scan replies that the scanner is off when no trigger is wired', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/scan'));
    expect(sent.some((m) => m.text.includes('not enabled'))).toBe(true);
  });

  test('/scan runs a cycle and reports the summary + base-drop reasons', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    bot.setGmgnScan(async () => ({
      trending: 25,
      quickPass: 8,
      basePass: 2,
      deliverable: 2,
      fresh: 1,
      delivered: true,
      baseDropSummary: 'market_cap×6, drawdown×2',
    }));
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/scan'));
    await waitUntil(() => sent.some((m) => m.text.includes('scan complete')));
    const text = sent.map((m) => m.text).join('\n');
    expect(text).toContain('Sent *1* new alert');
    expect(text).toContain('cap×6'); // base-drops surfaced even though 2 passed ("_" is escaped)
  });

  test('/scan reports an in-progress cycle when the trigger returns null', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    bot.setGmgnScan(async () => null);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/scan'));
    await waitUntil(() => sent.some((m) => m.text.includes('already running')));
  });

  test('/gmgnstatus is off when no status provider is wired', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/gmgnstatus'));
    expect(sent.some((m) => m.text.includes('not enabled'))).toBe(true);
  });

  test('/gmgnstatus shows last summary, base-drops, delivered, and error', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    bot.setGmgnStatus(() => ({
      scanning: false,
      lastSummary: {
        trending: 25,
        quickPass: 8,
        basePass: 3,
        deliverable: 3,
        fresh: 1,
        delivered: true,
        baseDropSummary: 'market_cap×5',
      },
      lastSummaryAt: Date.now() - 60_000,
      lastError: { message: 'rank 429', at: Date.now() - 120_000 },
      lastDelivered: { mint: MINT, symbol: 'WIF', at: Date.now() - 30_000 },
    }));
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/gmgnstatus'));
    const text = sent.map((m) => m.text).join('\n');
    expect(text).toContain('GMGN scanner status');
    expect(text).toContain('Base\\-pass: *3*');
    expect(text).toContain('cap×5'); // "_" in market_cap is escaped
    expect(text).toContain('WIF');
    expect(text).toContain('rank 429');
  });

  test('/testalert previews both alert styles with live Meteora links', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    bot.setMeteoraLinker(async () => [
      { poolAddress: 'P1', quoteSymbol: 'USDC', url: 'https://app.meteora.ag/dlmm/P1' },
    ]);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/testalert'));
    await waitUntil(() => sent.some((m) => m.text.includes('Example alerts')));
    const all = sent.map((m) => m.text).join('\n');
    expect(all).toContain('ATH Drawdown Alert'); // watch-style example
    expect(all).toContain('GMGN Screening Alert'); // gmgn-style example
    expect(all).toContain('SOL/USDC'); // live Meteora pool link
    expect(all).toContain('Wrapped SOL'); // curated sample
  });

  test('/testalert still renders when no Meteora linker is wired', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/testalert'));
    await waitUntil(() => sent.some((m) => m.text.includes('Example alerts')));
    expect(sent.map((m) => m.text).join('\n')).toContain(SOL_MINT_FOR_TEST);
  });

  test('/check renders the full token card in USD with volume + age', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, [], fetcherWith(50, 100));
    bot.setGmgnEnricher(async () => ({
      symbol: 'WIF',
      fdvUsd: 980_000,
      fdvAthUsd: 2_650_000,
      priceUsd: 0.00042,
      athUsd: 0.00113,
      volumeUsd: 4_700_000,
      ageHours: 52,
      holderCount: 4321,
    }));
    bot.setMeteoraLinker(async () => [
      { poolAddress: 'P1', quoteSymbol: 'SOL', binStep: 80, baseFeePct: 0.8, url: 'https://app.meteora.ag/dlmm/P1' },
    ]);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, `/check ${MINT}`));
    await waitUntil(() => sent.some((m) => m.text.includes('Token Check')));
    const all = sent.map((m) => m.text).join('\n');
    expect(all).toContain(MINT); // contract line
    expect(all).toContain('USD:'); // price shown in USD (not SOL), from GMGN
    expect(all).toContain('FDV'); // enriched market cap
    expect(all).toContain('Vol:'); // 24h volume present
    expect(all).toContain('Age:'); // token age present
    expect(all).toContain('WIF/SOL 80/0\\.8%'); // Meteora pool link
    expect(all).not.toContain('SOL: '); // price must not be denominated in SOL
  });

  test('/check rejects an invalid mint', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    const sent = recorder(bot);
    await bot.handleUpdate(cmdUpdate(7, '/check not-a-mint'));
    expect(sent.some((m) => m.text.includes('Usage'))).toBe(true);
  });
});

describe('TelegramTransport reply threading (group tagging)', () => {
  /** Capture full sendMessage payloads (incl. reply_parameters). */
  function payloadRecorder(bot: TelegramTransport): Record<string, unknown>[] {
    const seen: Record<string, unknown>[] = [];
    bot.useApiInterceptor((method, p) => {
      if (method === 'getMe') return getMeResult;
      if (method === 'sendMessage') seen.push(p);
      return ok;
    });
    return seen;
  }

  test('a synchronous command reply is threaded to the caller message', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    const seen = payloadRecorder(bot);
    const upd = cmdUpdate(7, '/help');
    await bot.handleUpdate(upd);
    const msgId = (upd as unknown as { message: { message_id: number } }).message.message_id;
    expect(seen.length).toBeGreaterThan(0);
    expect((seen[0]!.reply_parameters as { message_id?: number })?.message_id).toBe(msgId);
  });

  test('async command follow-ups are also threaded to the caller', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, [], fetcherWith(50, 100));
    const seen = payloadRecorder(bot);
    const upd = cmdUpdate(7, `/check ${MINT}`);
    await bot.handleUpdate(upd);
    await waitUntil(() => seen.some((p) => String(p.text).includes('Token Check')));
    const msgId = (upd as unknown as { message: { message_id: number } }).message.message_id;
    // Every reply (ack + the card) references the caller's message.
    for (const p of seen) {
      expect((p.reply_parameters as { message_id?: number })?.message_id).toBe(msgId);
    }
  });
});

describe('TelegramTransport command menu', () => {
  test('lists the user-facing commands and respects Telegram limits', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    const menu = bot.commandMenu();
    const names = menu.map((c) => c.command);
    for (const expected of ['start', 'watch', 'list', 'scan', 'testalert', 'help', 'stop']) {
      expect(names).toContain(expected);
    }
    // Telegram constraints: command 1–32 chars, [a-z0-9_]; description 1–256 chars.
    for (const c of menu) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThanOrEqual(1);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
    expect(new Set(names).size).toBe(names.length); // no duplicates
  });

  test('publishes the menu via setMyCommands on start', async () => {
    const { bot } = await makeTransport({ allowedChatIds: [7] }, []);
    let setCommandsPayload: unknown;
    bot.useApiInterceptor((method, p) => {
      if (method === 'getMe') return getMeResult;
      if (method === 'setMyCommands') setCommandsPayload = p.commands;
      if (method === 'getUpdates') return { ok: true, result: [] };
      return ok;
    });
    await bot.start();
    await bot.stop();
    expect(Array.isArray(setCommandsPayload)).toBe(true);
    expect((setCommandsPayload as BotCommand[]).some((c) => c.command === 'watch')).toBe(true);
  });
});
