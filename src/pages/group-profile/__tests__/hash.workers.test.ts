/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildProfileDoc, putProfileDoc } from '../../../lib/groups/profileDocs';
import { GET } from '../[hash].json';

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
});
