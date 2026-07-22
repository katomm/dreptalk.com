// Unit tests for the Telegram Bot API sender: fetch is injected, so no real
// network traffic; the workers pool is not needed here.
import { describe, it, expect } from 'vitest';
import { sendTelegramMessage, isTelegramChatDead, type TelegramSendResult } from './telegram.js';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('sendTelegramMessage', () => {
  it('POSTs sendMessage with chat_id, text and disabled link preview', async () => {
    const { impl, calls } = fakeFetch(200, { ok: true });
    const result = await sendTelegramMessage('TOKEN', '12345', 'hello', impl);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).toEqual({ chat_id: '12345', text: 'hello', link_preview_options: { is_disabled: true } });
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('returns status and description on failure', async () => {
    const { impl } = fakeFetch(403, { ok: false, description: 'Forbidden: bot was blocked by the user' });
    const result = await sendTelegramMessage('TOKEN', '12345', 'hello', impl);
    expect(result).toEqual({ ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' });
  });

  it('survives a non-JSON error body', async () => {
    const impl = (async () => new Response('Bad Gateway', { status: 502 })) as typeof fetch;
    const result = await sendTelegramMessage('TOKEN', '1', 'x', impl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.description).toBe('');
  });

  it('returns ok:false status 0 when fetch itself throws', async () => {
    const impl = (async () => { throw new Error('network down'); }) as typeof fetch;
    const result = await sendTelegramMessage('TOKEN', '1', 'x', impl);
    expect(result).toEqual({ ok: false, status: 0, description: 'network down' });
  });
});

describe('isTelegramChatDead', () => {
  const r = (status: number, description = ''): TelegramSendResult => ({ ok: false, status, description });
  it('403 is dead (user blocked the bot)', () => expect(isTelegramChatDead(r(403))).toBe(true));
  it('400 chat not found is dead', () => expect(isTelegramChatDead(r(400, 'Bad Request: chat not found'))).toBe(true));
  it('other 400s are not dead', () => expect(isTelegramChatDead(r(400, 'Bad Request: message is too long'))).toBe(false));
  it('429/5xx are transient, not dead', () => {
    expect(isTelegramChatDead(r(429))).toBe(false);
    expect(isTelegramChatDead(r(500))).toBe(false);
  });
  it('a successful send is never dead', () => expect(isTelegramChatDead({ ok: true, status: 200, description: '' })).toBe(false));
});
