/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drepIdForCredential } from '../../../../lib/groups/ids';

const net = vi.hoisted(() => ({ network: 'preprod' }));
vi.mock('@/lib/api/response', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/response')>()),
  currentNetwork: () => ({ network: net.network, koiosBaseUrl: 'https://koios.invalid/api/v1' }),
}));

const koios = vi.hoisted(() => ({ status: new Map<string, string>(), calls: 0 }));
vi.mock('@/lib/koios/client', () => ({
  createKoiosClient: () => ({
    drepInfo: async (id: string) => {
      koios.calls += 1;
      const s = koios.status.get(id);
      return s ? { drep_id: id, hex: '', has_script: false, drep_status: s, deposit: null, active: true, expires_epoch_no: null } : null;
    },
  }),
}));

import { GET } from '../check-drep';

// Groups run on mainnet now, so the off path is tested with mainnet left out of the list.
vi.mock('@/lib/groups/gate', async (orig) => {
  const real = await orig<typeof import('@/lib/groups/gate')>();
  const on = ['preprod'] as const;
  return { DREP_GROUPS_NETWORKS: on, drepGroupsAvailable: (n: Parameters<typeof real.drepGroupsAvailable>[0]) => real.drepGroupsAvailable(n, on) };
});

const ALICE = 'a1'.repeat(28);
const aliceId = drepIdForCredential({ kind: 'key', hash: ALICE });
const RETIRED = drepIdForCredential({ kind: 'key', hash: 'b2'.repeat(28) });
const UNKNOWN = drepIdForCredential({ kind: 'key', hash: 'c3'.repeat(28) });
const SCRIPT = drepIdForCredential({ kind: 'script', hash: 'd4'.repeat(28) });

type User = { id: string; roles: string[]; drepId?: string } | null;
const DREP: User = { id: 'u-check', roles: ['drep'], drepId: aliceId };
const call = (user: User, id: string) =>
  GET({
    url: new URL(`https://dreptalk.com/api/groups/check-drep?id=${encodeURIComponent(id)}`),
    locals: { user } as unknown as App.Locals,
  } as Parameters<typeof GET>[0]);

beforeEach(async () => {
  net.network = 'preprod';
  koios.calls = 0;
  koios.status = new Map([
    [aliceId, 'registered'],
    [RETIRED, 'retired'],
  ]);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO dreps (drep_id, status, active, last_synced_at, created_at, slug, name) VALUES (?, 'registered', 1, 0, 0, 'alice', 'Alice')`,
  )
    .bind(aliceId)
    .run();
});

describe('GET /api/groups/check-drep', () => {
  it('answers a registered key DRep with its key hash and name', async () => {
    const res = await call(DREP, aliceId);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ registered: true, script: false, keyHash: ALICE, name: 'Alice' });
  });

  it('answers retired and unknown keys as not registered', async () => {
    expect(await (await call(DREP, RETIRED)).json()).toMatchObject({ registered: false, script: false });
    expect(await (await call(DREP, UNKNOWN)).json()).toMatchObject({ registered: false, script: false, name: null });
  });

  it('refuses a script DRep without asking Koios, and a bad id', async () => {
    expect(await (await call(DREP, SCRIPT)).json()).toEqual({ registered: false, script: true, keyHash: null, name: null });
    expect(koios.calls).toBe(0);
    expect((await call(DREP, 'drep1nonsense')).status).toBe(400);
  });

  it('needs a DRep or group signer session', async () => {
    expect((await call(null, aliceId)).status).toBe(401);
    expect((await call({ id: 'plain', roles: ['member'] }, aliceId)).status).toBe(403);
    expect((await call({ id: 'signer', roles: ['group-signer'], drepId: RETIRED }, aliceId)).status).toBe(200);
  });

  it('is rate limited per user', async () => {
    const user = { id: 'u-rate-check', roles: ['drep'], drepId: aliceId };
    const statuses: number[] = [];
    for (let i = 0; i < 24; i++) statuses.push((await call(user, aliceId)).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
  });

  it('answers 404 off preprod', async () => {
    net.network = 'mainnet';
    expect((await call(DREP, aliceId)).status).toBe(404);
  });
});
