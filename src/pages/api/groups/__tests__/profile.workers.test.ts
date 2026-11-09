/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { getProfileDocBody } from '../../../../lib/groups/profileDocs';
import { POST } from '../profile';

const net = vi.hoisted(() => ({ network: 'preprod' }));
vi.mock('@/lib/api/response', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/response')>()),
  currentNetwork: () => ({ network: net.network }),
}));

type User = { id: string; roles: string[]; drepId?: string } | null;
/** The fields every hosted profile needs besides the name. */
const REQ = { description: 'DReps who vote together.', image: 'https://dreptalk.com/drep-images/c.png' };
const call = (user: User, body: unknown, headers: Record<string, string> = {}) =>
  POST({
    request: new Request('https://dreptalk.com/api/groups/profile', {
      method: 'POST',
      headers: { origin: 'https://dreptalk.com', 'cf-connecting-ip': '203.0.113.7', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { user } as unknown as App.Locals,
  } as Parameters<typeof POST>[0]);

describe('POST /api/groups/profile', () => {
  it('rejects a post without a DRep or group signer session and past the rate limit', async () => {
    expect((await call(null, { name: 'G' })).status).toBe(401);
    expect((await call({ id: 'plain-1', roles: ['member'] }, { name: 'G' })).status).toBe(403);
    expect((await call({ id: 'spo-1', roles: ['spo'] }, { name: 'G' })).status).toBe(403);

    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push((await call({ id: 'rate-user', roles: ['group-signer'] }, { name: `G${i}`, ...REQ }, { 'cf-connecting-ip': `198.51.100.${i}` })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
  });

  it('hosts a valid profile for a drep and a group signer and returns the content url', async () => {
    for (const [id, role, ip] of [['u-drep', 'drep', '192.0.2.1'], ['u-signer', 'group-signer', '192.0.2.2']] as const) {
      const res = await call({ id, roles: [role] }, { name: ' Council ', ...REQ, website: 'https://c.test' }, { 'cf-connecting-ip': ip });
      expect(res.status).toBe(200);
      const j = (await res.json()) as { url: string; hash: string };
      expect(j.url).toBe(`https://dreptalk.com/group-profile/${j.hash}.json`);
      expect(await getProfileDocBody(env.DB as D1Database, j.hash)).toContain('"name":"Council"');
    }
  });

  it('validates the body and the size', async () => {
    const u = { id: 'u-valid', roles: ['drep'] };
    const bad = (b: unknown, ip: string) => call(u, b, { 'cf-connecting-ip': ip });
    expect((await bad('not json', '192.0.2.10')).status).toBe(400);
    expect((await bad({ name: 'x'.repeat(121), ...REQ }, '192.0.2.12')).status).toBe(400);
    expect((await bad({ name: 'G', ...REQ, website: 'ftp://x.test' }, '192.0.2.13')).status).toBe(400);
    expect((await bad({ name: 'G', ...REQ, description: 'd'.repeat(2001) }, '192.0.2.14')).status).toBe(400);
    expect((await bad({ name: 'G', ...REQ, charter: `https://c.test/${'a'.repeat(500)}` }, '192.0.2.15')).status).toBe(400);
    expect((await bad({ name: 'G', ...REQ, image: 'ftp://x.test/i.png' }, '192.0.2.16')).status).toBe(400);
  });

  it('refuses a profile without a name, a description or an image', async () => {
    const u = { id: 'u-required', roles: ['drep'] };
    const cases: Array<[unknown, string]> = [
      [{ ...REQ }, 'name'],
      [{ name: '  ', ...REQ }, 'name'],
      [{ name: 'G', image: REQ.image, website: 'https://c.test' }, 'description'],
      [{ name: 'G', description: ' ', image: REQ.image }, 'description'],
      [{ name: 'G', description: REQ.description }, 'image'],
      [{ name: 'G', description: REQ.description, image: '' }, 'image'],
    ];
    for (const [i, [body, field]] of cases.entries()) {
      const res = await call(u, body, { 'cf-connecting-ip': `192.0.2.${30 + i}` });
      expect(res.status, field).toBe(422);
      expect(await res.json(), field).toEqual({ error: `missing ${field}` });
    }
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM drep_group_profile_docs WHERE created_by = ?').bind(u.id).first<{ n: number }>();
    expect(before?.n).toBe(0);
  });

  it('answers 404 off preprod', async () => {
    net.network = 'mainnet';
    try {
      expect((await call({ id: 'u-main', roles: ['drep'] }, { name: 'G', ...REQ })).status).toBe(404);
    } finally {
      net.network = 'preprod';
    }
  });
});
