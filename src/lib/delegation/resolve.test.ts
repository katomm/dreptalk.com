import { describe, it, expect } from 'vitest';
import { resolveDelegation } from './resolve.js';

const base = { stake_address: 'stake_test1a', status: 'registered', delegated_pool: null, total_balance: '1' };
// A syntactically valid CIP-129 DRep id (key credential, all-zero hash). Verified
// against identity.test.ts's own parseDrepId assertion: parseDrepId(VALID_DREP)
// resolves to { kind: 'key', hashHex: '00'.repeat(28) }, i.e. non-null.
const VALID_DREP = 'drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n';

describe('resolveDelegation', () => {
  it('maps a valid drep credential to a drep state', () => {
    expect(resolveDelegation({ ...base, delegated_drep: VALID_DREP })).toEqual({ kind: 'resolved', state: { type: 'drep', drepId: VALID_DREP } });
  });
  it('maps the always-abstain markers to abstain', () => {
    expect(resolveDelegation({ ...base, delegated_drep: 'drep_always_abstain' })).toEqual({ kind: 'resolved', state: { type: 'abstain' } });
    expect(resolveDelegation({ ...base, delegated_drep: 'abstain' })).toEqual({ kind: 'resolved', state: { type: 'abstain' } });
  });
  it('maps the always-no-confidence markers to no_confidence', () => {
    expect(resolveDelegation({ ...base, delegated_drep: 'drep_always_no_confidence' })).toEqual({ kind: 'resolved', state: { type: 'no_confidence' } });
  });
  it('maps a null delegation to none', () => {
    expect(resolveDelegation({ ...base, delegated_drep: null })).toEqual({ kind: 'resolved', state: { type: 'none' } });
  });
  it('rejects an unknown / malformed delegated_drep as invalid (fail-closed), never a drep id', () => {
    expect(resolveDelegation({ ...base, delegated_drep: 'not-a-real-value' })).toEqual({ kind: 'invalid', raw: 'not-a-real-value' });
  });
});
