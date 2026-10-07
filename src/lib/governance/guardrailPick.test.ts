// Unit tests for pickConstitutionScriptHash: which ratified row decides the
// guardrail in force, and how its own slot maps to known, absent or unknown.
import { describe, it, expect } from 'vitest';
import { pickConstitutionScriptHash } from './guardrailPick.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from './guardrailScript.js';
import type { ProposalListRow } from '../koios/client.js';

const OTHER = 'ab'.repeat(28);
const ANCHOR = { url: 'ipfs://bafkrei', dataHash: '7c05f74f644daac5be3b432357d133659cc76fff6a46bfb4355bc82c8992fa95' };

function row(type: string, ratified: number | null, description: unknown): ProposalListRow {
  return {
    proposal_tx_hash: 'a'.repeat(64),
    proposal_index: 0,
    proposal_id: 'gov_action1test',
    proposal_type: type,
    proposed_epoch: 1,
    ratified_epoch: ratified,
    enacted_epoch: null,
    expired_epoch: null,
    dropped_epoch: null,
    proposal_description: description,
  };
}

const constitution = (epoch: number | null, body: Record<string, unknown>) =>
  row('NewConstitution', epoch, { tag: 'NewConstitution', contents: [null, body] });
const treasury = (epoch: number | null, hash: unknown) =>
  row('TreasuryWithdrawals', epoch, {
    tag: 'TreasuryWithdrawals',
    contents: [[[{ network: 'Testnet', credential: { keyHash: '60adcde454590dbfe5935f8bc29619fe608d7cdd631580cc78b67763' } }, 1000000]], hash],
  });
const paramChange = (epoch: number | null, hash: unknown) =>
  row('ParameterChange', epoch, { tag: 'ParameterChange', contents: [null, { minPoolCost: 1 }, hash] });

describe('pickConstitutionScriptHash', () => {
  it('reads the policy hash of a newest treasury withdrawal when no constitution was ever ratified', () => {
    expect(pickConstitutionScriptHash(null, treasury(304, GUARDRAIL_SCRIPT_HASH_HEX))).toEqual({
      state: 'known',
      scriptHash: GUARDRAIL_SCRIPT_HASH_HEX,
    });
  });

  it('reads the hash a ratified constitution set when it is the newer row', () => {
    expect(pickConstitutionScriptHash(constitution(400, { anchor: ANCHOR, script: OTHER }), paramChange(300, GUARDRAIL_SCRIPT_HASH_HEX))).toEqual({
      state: 'known',
      scriptHash: OTHER,
    });
  });

  it('lets a newer constitution without a script key replace an older hash', () => {
    expect(pickConstitutionScriptHash(constitution(400, { anchor: ANCHOR }), paramChange(300, GUARDRAIL_SCRIPT_HASH_HEX))).toEqual({
      state: 'absent',
    });
  });

  it('lets a newer constitution with an explicit null replace an older hash', () => {
    expect(pickConstitutionScriptHash(constitution(400, { anchor: ANCHOR, script: null }), treasury(300, OTHER))).toEqual({
      state: 'absent',
    });
  });

  it('lets a newer policy row with a null policy prove absence', () => {
    expect(pickConstitutionScriptHash(constitution(300, { anchor: ANCHOR, script: OTHER }), paramChange(400, null))).toEqual({
      state: 'absent',
    });
  });

  it('gives a tie to the constitution row', () => {
    expect(pickConstitutionScriptHash(constitution(400, { anchor: ANCHOR, script: OTHER }), treasury(400, GUARDRAIL_SCRIPT_HASH_HEX))).toEqual({
      state: 'known',
      scriptHash: OTHER,
    });
  });

  it('answers unknown when the deciding row is unreadable, without falling back to the older row', () => {
    expect(pickConstitutionScriptHash(constitution(300, { anchor: ANCHOR, script: OTHER }), paramChange(400, 'deadbeef'))).toEqual({
      state: 'unknown',
    });
  });

  it('answers unknown when nothing was ratified', () => {
    expect(pickConstitutionScriptHash(null, null)).toEqual({ state: 'unknown' });
    expect(pickConstitutionScriptHash(constitution(null, { anchor: ANCHOR }), treasury(null, GUARDRAIL_SCRIPT_HASH_HEX))).toEqual({
      state: 'unknown',
    });
  });
});
