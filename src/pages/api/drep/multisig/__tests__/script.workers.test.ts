/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for GET /api/drep/multisig/script.
// Calls the exported GET handler directly with a synthetic APIContext.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { nativeScriptHash, parseNativeScriptJson } from '@/lib/cardano/nativeScript';
import { encodeBech32 } from '@/lib/crypto/bech32';
import { hexToBytes } from '@/lib/crypto/hex';
import { DREP_SCRIPT_HEADER, DREP_KEY_HEADER } from '@/lib/cardano/identity';

const koiosMock = {
  scriptInfo: vi.fn<[string], Promise<{ script_hash: string; type: string; value: unknown } | null>>(),
};

vi.mock('@/lib/koios/client', () => ({
  createKoiosClient: () => koiosMock,
}));

import { GET } from '../script';

const SCRIPT_VALUE = { type: 'any', scripts: [{ type: 'sig', keyHash: 'a'.repeat(56) }] };
const SCRIPT_HASH = nativeScriptHash(parseNativeScriptJson(SCRIPT_VALUE)!);

function drepId(header: number, hashHex: string): string {
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(hexToBytes(hashHex), 1);
  return encodeBech32('drep', payload);
}

const NOW = 1_752_000_000;

async function seedUser(userId: string, drep: string | null) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO users (id, drep_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, 1, 0, 0, 0, 'drep', 'active', ?, ?)`,
  )
    .bind(userId, drep, NOW, NOW)
    .run();
}

function makeCtx(user: { id: string; roles: string[] } | null) {
  const request = new Request('https://dreptalk.com/api/drep/multisig/script');
  const locals = { user } as unknown as App.Locals;
  return { request, locals } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/drep/multisig/script', () => {
  it('returns 401 when the caller is not logged in', async () => {
    const res = await GET(makeCtx(null));
    expect(res.status).toBe(401);
  });

  it('returns 401 when the session lacks the drep role', async () => {
    const res = await GET(makeCtx({ id: 'sc-u1', roles: ['proposer'] }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when the session user has no drep_id', async () => {
    await seedUser('sc-u2', null);
    const res = await GET(makeCtx({ id: 'sc-u2', roles: ['drep'] }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not a member');
  });

  it('returns 422 for a key-credential DRep without asking Koios', async () => {
    await seedUser('sc-u3', drepId(DREP_KEY_HEADER, 'c'.repeat(56)));
    const res = await GET(makeCtx({ id: 'sc-u3', roles: ['drep'] }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('not a script drep');
    expect(koiosMock.scriptInfo).not.toHaveBeenCalled();
  });

  it('returns 422 for a Plutus script', async () => {
    await seedUser('sc-u4', drepId(DREP_SCRIPT_HEADER, SCRIPT_HASH));
    koiosMock.scriptInfo.mockResolvedValue({ script_hash: SCRIPT_HASH, type: 'plutusV2', value: null });
    const res = await GET(makeCtx({ id: 'sc-u4', roles: ['drep'] }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error.toLowerCase()).toContain('plutus');
  });

  it('returns 422 when the script hash does not match the DRep id', async () => {
    await seedUser('sc-u5', drepId(DREP_SCRIPT_HEADER, SCRIPT_HASH));
    koiosMock.scriptInfo.mockResolvedValue({
      script_hash: SCRIPT_HASH,
      type: 'timelock',
      value: { type: 'any', scripts: [{ type: 'sig', keyHash: 'f'.repeat(56) }] },
    });
    const res = await GET(makeCtx({ id: 'sc-u5', roles: ['drep'] }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('script hash mismatch');
  });

  it('returns the raw script value with no-store on success', async () => {
    await seedUser('sc-u6', drepId(DREP_SCRIPT_HEADER, SCRIPT_HASH));
    koiosMock.scriptInfo.mockResolvedValue({ script_hash: SCRIPT_HASH, type: 'timelock', value: SCRIPT_VALUE });
    const res = await GET(makeCtx({ id: 'sc-u6', roles: ['drep'] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ value: SCRIPT_VALUE });
    expect(koiosMock.scriptInfo).toHaveBeenCalledWith(SCRIPT_HASH);
  });

  it('returns 503 when Koios fails', async () => {
    await seedUser('sc-u7', drepId(DREP_SCRIPT_HEADER, SCRIPT_HASH));
    koiosMock.scriptInfo.mockRejectedValue(new Error('koios request failed: 500'));
    const res = await GET(makeCtx({ id: 'sc-u7', roles: ['drep'] }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('service unavailable');
  });
});
