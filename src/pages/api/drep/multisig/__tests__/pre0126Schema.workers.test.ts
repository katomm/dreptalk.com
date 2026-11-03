/// <reference types="@cloudflare/workers-types" />
// The vote multisig paths on a network without the group migrations: pending_multisig_tx keeps
// its original shape there, so no vote path may name a group column.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { currentNetwork } from '@/lib/api/response';
import { createPendingMultisig, deleteExpiredPending, getPendingMultisig, listPendingForDrep } from '@/lib/db/pendingMultisigTx';
import { drepGroupsAvailable } from '@/lib/groups/gate';
import { GET } from '../[id]';
import { GET as list } from '../list';
import { POST as witness } from '../[id]/witness';
import { POST as submit } from '../[id]/submit';
import { POST as submitted } from '../[id]/submitted';

// pending_multisig_tx in its shape before the group migrations (0037 only), set in place of the
// migrated table for each test and swapped back afterwards.
const PRE_0126_TABLE = `CREATE TABLE pending_multisig_tx (
  id TEXT PRIMARY KEY,
  drep_id TEXT NOT NULL,
  action TEXT NOT NULL,
  action_params TEXT NOT NULL,
  unsigned_tx_cbor TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  native_script TEXT NOT NULL,
  witnesses TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'collecting',
  tx_hash TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

async function usePre0126PendingTable(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE pending_multisig_tx RENAME TO pending_multisig_tx_migrated'),
    env.DB.prepare(PRE_0126_TABLE),
  ]);
}

async function restoreMigratedPendingTable(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DROP TABLE pending_multisig_tx'),
    env.DB.prepare('ALTER TABLE pending_multisig_tx_migrated RENAME TO pending_multisig_tx'),
  ]);
}

/** The column names of the live pending_multisig_tx. */
async function pendingColumns(): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('pending_multisig_tx')`).all<{ name: string }>();
  return results.map((r) => r.name);
}

const NOW = Math.floor(Date.now() / 1000);
const DREP = 'drep-script-legacy';
const USER = 'user-legacy';
const SCRIPT = JSON.stringify({ type: 'any', scripts: [{ type: 'sig', keyHash: 'a'.repeat(56) }] });

async function seedUser() {
  await env.DB.prepare(
    `INSERT INTO users (id, drep_id, is_drep, is_spo, is_cc, is_proposer, role, status, created_at, last_verified_at)
     VALUES (?, ?, 1, 0, 0, 0, 'drep', 'active', ?, ?)`,
  )
    .bind(USER, DREP, NOW, NOW)
    .run();
}

async function seedVote(id: string, expiresAt: number) {
  await createPendingMultisig(env.DB, {
    id,
    drepId: DREP,
    action: 'vote',
    actionParams: JSON.stringify({ gaId: `${'d'.repeat(64)}#0`, vote: 'yes' }),
    unsignedTxCbor: 'e'.repeat(128),
    bodyHash: 'f'.repeat(64),
    nativeScript: SCRIPT,
    createdBy: USER,
    createdAt: NOW - 100,
    expiresAt,
  });
}

function ctx(id: string | undefined, body?: unknown) {
  const request = new Request(`https://dreptalk.com/api/drep/multisig/${id ?? 'list'}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const locals = { user: { id: USER, roles: ['drep'] } } as unknown as App.Locals;
  return { request, locals, params: { id } } as never;
}

describe('vote multisig without the group migrations', () => {
  beforeEach(async () => {
    await usePre0126PendingTable();
    await seedUser();
  });
  afterEach(restoreMigratedPendingTable);

  it('runs on a network without groups against the original table shape', async () => {
    expect(drepGroupsAvailable(currentNetwork().network)).toBe(false);
    expect(await pendingColumns()).not.toContain('subject_kind');
  });

  it('serves a vote row on every vote route', async () => {
    await seedVote('legacy-vote', NOW + 86400);
    expect((await GET(ctx('legacy-vote'))).status).toBe(200);
    const listed = (await (await list(ctx(undefined))).json()) as { items: Array<{ id: string }> };
    expect(listed.items.map((i) => i.id)).toEqual(['legacy-vote']);
    // The row is found: the witness route rejects the malformed witness, not the id.
    expect((await witness(ctx('legacy-vote', { witnessSetHex: 'a100' }))).status).toBe(400);
    expect(await (await submit(ctx('legacy-vote', {}))).json()).toEqual({ error: 'not yet satisfied' });
    expect((await submitted(ctx('legacy-vote', { txHash: 'f'.repeat(64) }))).status).toBe(200);
    expect((await getPendingMultisig(env.DB, 'legacy-vote'))?.status).toBe('submitted');
  });

  it('lists and expires vote rows without naming the group columns', async () => {
    await seedVote('legacy-live', NOW + 86400);
    await seedVote('legacy-old', NOW - 1);
    expect((await listPendingForDrep(env.DB, DREP, NOW, false)).map((r) => r.id)).toEqual(['legacy-live']);
    expect(await deleteExpiredPending(env.DB, NOW, false)).toBe(1);
    expect(await getPendingMultisig(env.DB, 'legacy-old')).toBeNull();
    // The preprod filter would fail on this shape, which is why it stays behind the gate.
    await expect(deleteExpiredPending(env.DB, NOW, true)).rejects.toThrow(/subject_kind/);
  });
});
