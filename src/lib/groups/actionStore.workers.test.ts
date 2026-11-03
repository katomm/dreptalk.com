/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getPendingMultisig } from '../db/pendingMultisigTx.js';
import { cancelGroupAction, createGroupAction, freeStaleSlot, type NewGroupAction, openControlAction } from './actionStore.js';

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
    expect(await getPendingMultisig(env.DB, 'a')).toMatchObject({ status: 'cancelled', resolution: 'failed', resolved_at: 1300, cancelled_at: 1100 });
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
