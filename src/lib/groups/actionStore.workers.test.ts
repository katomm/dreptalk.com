/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getPendingMultisig } from '../db/pendingMultisigTx.js';
import {
  cancelGroupAction,
  createGroupAction,
  freeStaleSlot,
  type NewGroupAction,
  openControlAction,
  pruneResolvedGroupActions,
} from './actionStore.js';
import { GROUP_ACTION_PRUNE_PER_RUN, GROUP_ACTION_RETENTION_MS } from './constants.js';

const G1 = 'group1aaa';
const G2 = 'group1bbb';

const rec = (id: string, o: Partial<NewGroupAction> = {}): NewGroupAction => ({
  id,
  kind: 'group_dissolve',
  subjectKind: 'group',
  subjectId: G1,
  intent: { kind: 'group_dissolve', group: G1 },
  nativeScriptJson: '{"type":"sig","keyHash":"aa"}',
  unsignedTxCbor: '84',
  bodyHash: 'AB'.repeat(32),
  requiredSigners: ['CD'.repeat(28)],
  invalidHereafter: 500,
  feeInputs: [{ txHash: 'ef'.repeat(32), index: 1 }],
  feePayKeys: ['12'.repeat(28)],
  eventCount: 1,
  controlSlot: true,
  profileHash: null,
  createdBy: 'u-1',
  now: 1000,
  ...o,
});

describe('group action store', () => {
  it('stores every group column, lowercased, with the expiry ACTION_TTL_SECONDS ahead', async () => {
    expect(await createGroupAction(env.DB, rec('a', { profileHash: 'EE'.repeat(32) }))).toBe('created');
    expect(await getPendingMultisig(env.DB, 'a')).toMatchObject({
      drep_id: G1,
      action: 'group_dissolve',
      action_params: JSON.stringify({ kind: 'group_dissolve', group: G1 }),
      body_hash: 'ab'.repeat(32),
      native_script: '{"type":"sig","keyHash":"aa"}',
      witnesses: '[]',
      status: 'collecting',
      subject_kind: 'group',
      required_signers: JSON.stringify(['cd'.repeat(28)]),
      invalid_hereafter: 500,
      fee_inputs: JSON.stringify([{ txHash: 'ef'.repeat(32), index: 1 }]),
      fee_pay_keys: JSON.stringify(['12'.repeat(28)]),
      event_count: 1,
      control_slot: 1,
      profile_hash: 'ee'.repeat(32),
      created_at: 1000,
      expires_at: 1000 + 172_800,
      resolved_at: null,
    });
  });

  it('holds one control slot per group and lets other rows through', async () => {
    expect(await createGroupAction(env.DB, rec('a'))).toBe('created');
    expect(await createGroupAction(env.DB, rec('b'))).toBe('slot taken');
    expect(await getPendingMultisig(env.DB, 'b')).toBeNull();
    expect(await createGroupAction(env.DB, rec('c', { controlSlot: false, kind: 'group_approve' }))).toBe('created');
    expect(await createGroupAction(env.DB, rec('d', { subjectId: G2 }))).toBe('created');
    expect((await openControlAction(env.DB, G1))?.id).toBe('a');
    expect((await openControlAction(env.DB, G2))?.id).toBe('d');
  });

  it('keeps the slot on cancel and frees it for a stale seq', async () => {
    await createGroupAction(env.DB, rec('a'));
    expect(await cancelGroupAction(env.DB, 'a', 1100)).toBe(true);
    expect(await cancelGroupAction(env.DB, 'a', 1200)).toBe(false);
    expect(await openControlAction(env.DB, G1)).toMatchObject({ id: 'a', status: 'cancelled', cancelled_at: 1100 });
    expect(await createGroupAction(env.DB, rec('b'))).toBe('slot taken');
    await freeStaleSlot(env.DB, 'a', 1300);
    // The signing columns count seconds, resolved_at milliseconds like every resolution of the resolver.
    expect(await getPendingMultisig(env.DB, 'a')).toMatchObject({ status: 'cancelled', resolution: 'failed', resolved_at: 1_300_000, cancelled_at: 1100 });
    expect(await openControlAction(env.DB, G1)).toBeNull();
    expect(await createGroupAction(env.DB, rec('b'))).toBe('created');
  });

  it('leaves a submitted row to the resolver', async () => {
    await createGroupAction(env.DB, rec('a'));
    await env.DB.prepare(`UPDATE pending_multisig_tx SET status = 'submitted' WHERE id = 'a'`).run();
    await freeStaleSlot(env.DB, 'a', 1300);
    expect(await openControlAction(env.DB, G1)).toMatchObject({ id: 'a', resolved_at: null });
    expect(await cancelGroupAction(env.DB, 'a', 1400)).toBe(false);
  });
});

describe('group action retention', () => {
  const NOW = 2_000_000_000_000;
  const OLD = NOW - GROUP_ACTION_RETENTION_MS - 1;
  const resolve = (id: string, at: number) =>
    env.DB.prepare("UPDATE pending_multisig_tx SET resolution = 'applied', resolved_at = ? WHERE id = ?").bind(at, id).run();
  const ids = async (): Promise<string[]> =>
    ((await env.DB.prepare('SELECT id FROM pending_multisig_tx ORDER BY id').all<{ id: string }>()).results ?? []).map((r) => r.id);

  it('deletes group and member rows resolved more than 90 days ago and keeps fresh, open and vote rows', async () => {
    const row = (id: string, o: Partial<NewGroupAction> = {}) =>
      createGroupAction(env.DB, rec(id, { controlSlot: false, kind: 'group_approve', bodyHash: id.padEnd(64, '0'), ...o }));
    await row('a-old');
    await row('b-member-old', { kind: 'group_leave', subjectKind: 'member', subjectId: 'drep1x' });
    await row('c-fresh');
    await row('d-open');
    await row('e-never-included-old');
    await resolve('a-old', OLD);
    await resolve('b-member-old', OLD);
    await resolve('c-fresh', NOW - GROUP_ACTION_RETENTION_MS + 1000);
    await env.DB.prepare("UPDATE pending_multisig_tx SET resolution = 'never_included', resolved_at = ?1, never_included_at = ?1 WHERE id = 'e-never-included-old'")
      .bind(OLD)
      .run();
    // A vote row is not a group row, whatever its columns say.
    await env.DB.prepare(
      `INSERT INTO pending_multisig_tx (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script, created_by, created_at, expires_at, resolved_at)
       VALUES ('f-vote', 'drep1v', 'vote', '{}', '00', ?, '{}', 'u-1', 1, 2, ?)`,
    )
      .bind('ff'.repeat(32), OLD)
      .run();

    expect(await pruneResolvedGroupActions(env.DB, NOW)).toBe(3);
    expect(await ids()).toEqual(['c-fresh', 'd-open', 'f-vote']);
    expect(await pruneResolvedGroupActions(env.DB, NOW)).toBe(0);
  });

  it('deletes at most GROUP_ACTION_PRUNE_PER_RUN rows per run, the oldest first', async () => {
    const total = GROUP_ACTION_PRUNE_PER_RUN + 2;
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO pending_multisig_tx (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script, created_by, created_at, expires_at,
         subject_kind, resolution, resolved_at)
       SELECT printf('r%04d', i), 'group1aaa', 'group_approve', '{}', '00', printf('%064d', i), '{}', 'u-1', 1, 2, 'group', 'applied', ?2 - i FROM n`,
    )
      .bind(total, OLD)
      .run();
    expect(await pruneResolvedGroupActions(env.DB, NOW)).toBe(GROUP_ACTION_PRUNE_PER_RUN);
    // The newest two, resolved last, are what is left.
    expect(await ids()).toEqual(['r0001', 'r0002']);
    expect(await pruneResolvedGroupActions(env.DB, NOW)).toBe(2);
    expect(await ids()).toEqual([]);
  });
});
