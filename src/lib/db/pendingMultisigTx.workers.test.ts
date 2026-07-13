import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createPendingMultisig, getPendingMultisig, addPendingWitness,
  markPendingSubmitted, listPendingForDrep, deleteExpiredPending,
} from './pendingMultisigTx.js';

const base = {
  id: 'tok1', drepId: 'drep1xyz', action: 'vote' as const,
  actionParams: JSON.stringify({ gaId: `${'aa'.repeat(32)}#0`, vote: 'yes' }),
  unsignedTxCbor: 'deadbeef', bodyHash: 'ab'.repeat(32),
  nativeScript: JSON.stringify({ type: 'any', scripts: [{ type: 'sig', keyHash: 'cc'.repeat(28) }] }),
  createdBy: 'user1', createdAt: 1000, expiresAt: 9999999999,
};

describe('pendingMultisigTx', () => {
  it('creates and reads a row', async () => {
    await createPendingMultisig(env.DB, base);
    const row = await getPendingMultisig(env.DB, 'tok1');
    expect(row?.drep_id).toBe('drep1xyz');
    expect(row?.status).toBe('collecting');
    expect(JSON.parse(row!.witnesses)).toEqual([]);
  });

  it('appends witnesses', async () => {
    await createPendingMultisig(env.DB, { ...base, id: 'tok2' });
    expect(await addPendingWitness(env.DB, 'tok2', { key_hash: 'cc'.repeat(28), witness_hex: 'aa' }, 1001)).toBe('added');
    const row = await getPendingMultisig(env.DB, 'tok2');
    expect(JSON.parse(row!.witnesses)).toEqual([{ key_hash: 'cc'.repeat(28), witness_hex: 'aa' }]);
    expect(await addPendingWitness(env.DB, 'missing', { key_hash: 'x', witness_hex: 'y' }, 1001)).toBe('gone');
  });

  it('marks submitted', async () => {
    await createPendingMultisig(env.DB, { ...base, id: 'tok3' });
    await markPendingSubmitted(env.DB, 'tok3', 'ff'.repeat(32), 1002);
    const row = await getPendingMultisig(env.DB, 'tok3');
    expect(row?.status).toBe('submitted');
    expect(row?.tx_hash).toBe('ff'.repeat(32));
  });

  it('markPendingSubmitted is an atomic claim: only the first call wins', async () => {
    await createPendingMultisig(env.DB, { ...base, id: 'tok-claim' });
    // Two concurrent submits serialize; only the first flips collecting -> submitted.
    const first = await markPendingSubmitted(env.DB, 'tok-claim', 'aa'.repeat(32), 1002);
    const second = await markPendingSubmitted(env.DB, 'tok-claim', 'bb'.repeat(32), 1003);
    expect(first).toBe(true);
    expect(second).toBe(false); // loser matches no row, changes nothing
    const row = await getPendingMultisig(env.DB, 'tok-claim');
    expect(row?.status).toBe('submitted');
    expect(row?.tx_hash).toBe('aa'.repeat(32)); // winner's hash preserved, not overwritten
  });

  it('lists collecting for a drep and deletes expired', async () => {
    await createPendingMultisig(env.DB, { ...base, id: 'tok4', drepId: 'drepA', expiresAt: 5000 });
    await createPendingMultisig(env.DB, { ...base, id: 'tok5', drepId: 'drepA', expiresAt: 50 });
    expect((await listPendingForDrep(env.DB, 'drepA', 1000)).map((r) => r.id)).toEqual(['tok4']);
    expect(await deleteExpiredPending(env.DB, 1000)).toBe(1);
    expect(await getPendingMultisig(env.DB, 'tok5')).toBeNull();
  });
});
