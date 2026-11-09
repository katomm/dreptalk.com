/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { buildProfileDoc, putProfileDoc } from '../../../lib/groups/profileDocs';
import { GET } from '../[hash].json';

// Groups run on mainnet now, so the off path is tested with mainnet left out of the list.
vi.mock('@/lib/groups/gate', async (orig) => {
  const real = await orig<typeof import('@/lib/groups/gate')>();
  const on = ['preprod'] as const;
  return { DREP_GROUPS_NETWORKS: on, drepGroupsAvailable: (n: Parameters<typeof real.drepGroupsAvailable>[0]) => real.drepGroupsAvailable(n, on) };
});

const net = vi.hoisted(() => ({ network: 'preprod' }));
vi.mock('@/lib/api/response', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/response')>()),
  currentNetwork: () => ({ network: net.network }),
}));

const get = (hash: string) => GET({ params: { hash }, locals: {} as App.Locals } as unknown as Parameters<typeof GET>[0]);

describe('GET /group-profile/[hash].json', () => {
  it('serves the stored bytes with an immutable cache', async () => {
    const { body, hash } = buildProfileDoc({ name: 'Council' });
    await putProfileDoc(env.DB as D1Database, { hash, body, createdBy: 'u1', now: Date.now() });
    const res = await get(hash);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('answers 404 for an unknown or malformed hash', async () => {
    expect((await get('b'.repeat(64))).status).toBe(404);
    expect((await get('xyz')).status).toBe(404);
    expect((await get('A'.repeat(64))).status).toBe(404);
  });

  it('answers 404 off preprod', async () => {
    const { body, hash } = buildProfileDoc({ name: 'Council' });
    await putProfileDoc(env.DB as D1Database, { hash, body, createdBy: 'u1', now: Date.now() });
    net.network = 'mainnet';
    try {
      expect((await get(hash)).status).toBe(404);
    } finally {
      net.network = 'preprod';
    }
  });
});
