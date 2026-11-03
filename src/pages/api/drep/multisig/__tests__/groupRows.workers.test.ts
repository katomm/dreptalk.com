/// <reference types="@cloudflare/workers-types" />
// The vote routes answer 404 for a group row that shares the signing table.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createPendingMultisig } from '@/lib/db/pendingMultisigTx';
import { GET } from '../[id]';
import { POST as witness } from '../[id]/witness';
import { POST as submit } from '../[id]/submit';
import { POST as submitted } from '../[id]/submitted';

const NOW = 1_752_000_000;
const SCRIPT = JSON.stringify({ type: 'sig', keyHash: 'aa'.repeat(28) });

async function seed(id: string, action: 'vote' | 'group_join', subjectKind: string) {
  await createPendingMultisig(env.DB, {
    id,
    drepId: 'drep1member',
    action,
    actionParams: '{}',
    unsignedTxCbor: 'ee'.repeat(64),
    bodyHash: 'ff'.repeat(32),
    nativeScript: SCRIPT,
    createdBy: 'user-g',
    createdAt: NOW,
    expiresAt: NOW + 86400,
  });
  await env.DB.prepare(`UPDATE pending_multisig_tx SET subject_kind = ? WHERE id = ?`).bind(subjectKind, id).run();
}

function ctx(id: string, body?: unknown) {
  const request = new Request(`https://dreptalk.com/api/drep/multisig/${id}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const locals = { user: { id: 'u1', roles: ['drep'] } } as unknown as App.Locals;
  return { request, locals, params: { id } } as never;
}

describe('vote routes and group rows', () => {
  it('answers 404 for a group row on every vote route', async () => {
    await seed('grp-row', 'group_join', 'member');
    expect((await GET(ctx('grp-row'))).status).toBe(404);
    expect((await witness(ctx('grp-row', { witnessSetHex: 'a100' }))).status).toBe(404);
    expect((await submit(ctx('grp-row', {}))).status).toBe(404);
    expect((await submitted(ctx('grp-row', { txHash: 'ab'.repeat(32) }))).status).toBe(404);
  });

  it('answers 404 for a vote action stored with another subject kind', async () => {
    await seed('odd-row', 'vote', 'group');
    expect((await GET(ctx('odd-row'))).status).toBe(404);
  });

  it('still serves a vote row', async () => {
    await seed('vote-row', 'vote', 'drep');
    expect((await GET(ctx('vote-row'))).status).toBe(200);
  });
});
