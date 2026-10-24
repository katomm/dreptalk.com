/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handlePoolEconomics, handlePublicPoolEconomics } from './poolEconomicsHandler.js';

const preprodCfg = { network: 'preprod', networkId: 0, epochAnchor: { epoch: 300, unixSeconds: 1_790_000_000 } } as never;
const testEnv = { ...env } as Cloudflare.Env;

const BODY_300 = JSON.stringify({ epoch: 300, pools: [] });
const BODY_299 = JSON.stringify({ epoch: 299, pools: [] });

function ctx(headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }, user: unknown = { id: 'u1', roles: [] }) {
  const request = new Request('https://dreptalk.com/api/gov-action/pool-economics', { headers });
  return { request, locals: { user } as App.Locals };
}

function publicCtx(headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }, query = '') {
  return { request: new Request(`https://dreptalk.com/api/pool-economics${query}`, { headers }), locals: {} as App.Locals };
}

async function store(epoch: number, body: string) {
  await env.DB.prepare('INSERT OR REPLACE INTO pool_economics (epoch, body, computed_at) VALUES (?, ?, ?)').bind(epoch, body, 1).run();
}

const failingDb = {
  prepare: () => {
    throw new Error('d1 down');
  },
} as unknown as D1Database;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM pool_economics').run();
});

describe('handlePoolEconomics (gated)', () => {
  const deps = { network: preprodCfg, env: testEnv };

  it('answers the stored body verbatim as json with no-store', async () => {
    await store(300, BODY_300);
    const res = await handlePoolEconomics(ctx(), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(BODY_300);
  });

  it('answers the previous epoch row after an epoch boundary', async () => {
    await store(299, BODY_299);
    const res = await handlePoolEconomics(ctx(), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY_299);
  });

  it('answers the newest stored row', async () => {
    await store(299, BODY_299);
    await store(300, BODY_300);
    expect(await (await handlePoolEconomics(ctx(), deps)).text()).toBe(BODY_300);
  });

  it('answers 503 pool_data_unavailable without a row', async () => {
    const res = await handlePoolEconomics(ctx(), deps);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'pool_data_unavailable' });
  });

  it('answers 503 when D1 throws', async () => {
    const res = await handlePoolEconomics(ctx(), { network: preprodCfg, env: { ...testEnv, DB: failingDb } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'pool_data_unavailable' });
  });

  it('refuses a cross-origin request with 403', async () => {
    await store(300, BODY_300);
    expect((await handlePoolEconomics(ctx({ origin: 'https://evil.example' }), deps)).status).toBe(403);
    expect((await handlePoolEconomics(ctx({ 'sec-fetch-site': 'cross-site' }), deps)).status).toBe(403);
  });

  it('refuses a request without a session with 401', async () => {
    await store(300, BODY_300);
    expect((await handlePoolEconomics(ctx(undefined, null), deps)).status).toBe(401);
  });
});

describe('handlePublicPoolEconomics', () => {
  it('answers without a session on mainnet and preprod', async () => {
    await store(300, BODY_300);
    // The handler reads only the DB binding, so the network never matters.
    const res = await handlePublicPoolEconomics(publicCtx(), { env: testEnv });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY_300);
  });

  it('answers the stored body verbatim as json', async () => {
    await store(300, BODY_300);
    const res = await handlePublicPoolEconomics(publicCtx(), { env: testEnv });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(BODY_300);
  });

  it('sends cache-control public, max-age=3600 on 200', async () => {
    await store(300, BODY_300);
    const res = await handlePublicPoolEconomics(publicCtx(), { env: testEnv });
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('serves a newly stored epoch on the next request', async () => {
    await store(300, BODY_300);
    expect(await (await handlePublicPoolEconomics(publicCtx(), { env: testEnv })).text()).toBe(BODY_300);
    const body301 = JSON.stringify({ epoch: 301, pools: [] });
    await store(301, body301);
    expect(await (await handlePublicPoolEconomics(publicCtx(), { env: testEnv })).text()).toBe(body301);
  });

  it('refuses a cross-origin request with 403', async () => {
    await store(300, BODY_300);
    const foreign = await handlePublicPoolEconomics(publicCtx({ origin: 'https://evil.example' }), { env: testEnv });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('cache-control')).toBe('no-store');
    expect((await handlePublicPoolEconomics(publicCtx({ 'sec-fetch-site': 'cross-site' }), { env: testEnv })).status).toBe(403);
  });

  it('answers 503 no-store without a row', async () => {
    const res = await handlePublicPoolEconomics(publicCtx(), { env: testEnv });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'pool_data_unavailable' });
  });

  it('answers 503 no-store when D1 throws', async () => {
    const res = await handlePublicPoolEconomics(publicCtx(), { env: { ...testEnv, DB: failingDb } });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('handlePublicPoolEconomics with ?epoch', () => {
  const same = { 'sec-fetch-site': 'same-origin' };
  const BODY_613 = JSON.stringify({ epoch: 613, pools: [] });
  const BODY_662 = JSON.stringify({ epoch: 662, pools: [] });
  beforeEach(async () => {
    await store(613, BODY_613);
    await store(662, BODY_662);
  });

  it('serves the stored epoch with a long cache', async () => {
    const res = await handlePublicPoolEconomics(publicCtx(same, '?epoch=613'), { env: testEnv });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(await res.text()).toBe(BODY_613);
  });

  it('answers 404 no-store for a missing epoch', async () => {
    const res = await handlePublicPoolEconomics(publicCtx(same, '?epoch=614'), { env: testEnv });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it.each(['007', '-1', '1e3', 'abc', '9999999', ''])('answers 404 no-store for epoch=%s', async (v) => {
    const res = await handlePublicPoolEconomics(publicCtx(same, `?epoch=${v}`), { env: testEnv });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('still serves the newest epoch without the parameter', async () => {
    const res = await handlePublicPoolEconomics(publicCtx(), { env: testEnv });
    expect(await res.text()).toBe(BODY_662);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });
});
