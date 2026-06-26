import { describe, it, expect } from 'vitest';
import { resolveDRep, resolveProposer, resolveSpo, resolveCc, resolveScriptDRep } from './resolveRole';
import type { DrepInfo, AccountInfo, PoolCalidusKeyRow, CommitteeMember, ScriptInfo } from '../koios/client';

// Minimal fake koios client: only the methods under test need to be present.
type FakeKoios = {
  drepInfo: (id: string) => Promise<DrepInfo | null>;
  accountInfo: (addr: string) => Promise<AccountInfo | null>;
  proposalsByReturnAddress: (addr: string) => Promise<Array<{ proposal_id: string; return_address: string; proposal_type: string }>>;
  poolCalidusKey: (pubKeyHex: string) => Promise<PoolCalidusKeyRow | null>;
  committeeInfo: () => Promise<CommitteeMember[]>;
  scriptInfo: (scriptHash: string) => Promise<ScriptInfo | null>;
};

function makeKoios(overrides: Partial<FakeKoios> = {}): FakeKoios {
  return {
    drepInfo: () => Promise.resolve(null),
    accountInfo: () => Promise.resolve(null),
    proposalsByReturnAddress: () => Promise.resolve([]),
    poolCalidusKey: () => Promise.resolve(null),
    committeeInfo: () => Promise.resolve([]),
    scriptInfo: () => Promise.resolve(null),
    ...overrides,
  };
}

const DREP_ID = 'drep1ygfpzwl3u0r7e5dm6z7gz8afyw60rv5lnmtgcnw4nnrrzrdmytsk';
const STAKE_ADDR = 'stake1uxpdrerp9wrxunfh6ukyv5267j70fzxgw0fr3z8zeac5vyqhf9jhy';
const CALIDUS_PUBKEY = '200bff1edb79e633786f7f1bc2989d61db7cb1211e6a55b6efc5b6203ff711dd';
const POOL_ID = 'pool10dtwvn64akqjdtn9d4pd2mnhpxfgp76hvsfkgmfwugrsxef3y2p';
const CC_HOT_HEX = 'be4b5ca31023088940eb952d01bd365af0c32d13e99e3c06929ef89c';
const CC_HOT_ID = 'cc_hot1qwlykh9rzq3s3z2qaw2j6qdaxed0psedz05eu0qxj20038qc7zdu7';

function calidusRow(overrides: Partial<PoolCalidusKeyRow> = {}): PoolCalidusKeyRow {
  return {
    pool_id_bech32: POOL_ID,
    calidus_pub_key: CALIDUS_PUBKEY,
    calidus_id_bech32: 'calidus15xdvep33kxuvep5h6h0vqzarsc5f4khre4lr7ptv8qefs2s0vtnj6',
    registered: true,
    pool_status: 'registered',
    ...overrides,
  };
}

function ccMember(overrides: Partial<CommitteeMember> = {}): CommitteeMember {
  return {
    status: 'authorized',
    cc_hot_id: CC_HOT_ID,
    cc_cold_id: 'cc_cold1zvcxrfwegfn9ls72cmfchty3cnczwtztc2e48eyxxwnrw3cwfypz8',
    cc_hot_hex: CC_HOT_HEX,
    cc_cold_hex: '3061a5d942665fc3cac6d38bac91c4f0272c4bc2b353e48633a63747',
    expiration_epoch: 242,
    cc_hot_has_script: false,
    cc_cold_has_script: false,
    ...overrides,
  };
}

function drepFixture(overrides: Partial<DrepInfo> = {}): DrepInfo {
  return {
    drep_id: DREP_ID,
    hex: 'abc123',
    has_script: false,
    drep_status: 'registered',
    deposit: '500000000',
    active: true,
    expires_epoch_no: 600,
    ...overrides,
  };
}

// --- resolveDRep ---

describe('resolveDRep', () => {
  it('returns isDrep true when registered, active, and not a script', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture()) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(true);
    expect(result.active).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns isDrep false with reason "script" when has_script is true', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture({ has_script: true })) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(false);
    expect(result.reason).toBe('script');
  });

  it('returns isDrep false with reason "inactive" when registered but inactive', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture({ active: false })) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(false);
    expect(result.active).toBe(false);
    expect(result.reason).toBe('inactive');
  });

  it('returns isDrep false with reason "not registered" when drep_status is retired', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture({ drep_status: 'retired' })) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(false);
    expect(result.reason).toBe('not registered');
  });

  it('returns isDrep false when drepInfo returns null (not found)', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(null) });
    const result = await resolveDRep(koios, DREP_ID);
    expect(result.isDrep).toBe(false);
    expect(result.active).toBe(false);
  });
});

// --- resolveProposer ---

describe('resolveProposer', () => {
  it('returns isProposer true with proposalIds when a match is found', async () => {
    const proposals = [
      { proposal_id: 'gov_action1abc', return_address: STAKE_ADDR, proposal_type: 'InfoAction' },
    ];
    const koios = makeKoios({ proposalsByReturnAddress: () => Promise.resolve(proposals) });

    const result = await resolveProposer(koios, STAKE_ADDR);

    expect(result.isProposer).toBe(true);
    expect(result.proposalIds).toEqual(['gov_action1abc']);
  });

  it('filters out entries whose return_address does not match exactly (case-sensitive)', async () => {
    const otherAddr = STAKE_ADDR.toUpperCase();
    const proposals = [
      // Different address, should not match
      { proposal_id: 'gov_action1abc', return_address: otherAddr, proposal_type: 'InfoAction' },
      // Same address, should match
      { proposal_id: 'gov_action1def', return_address: STAKE_ADDR, proposal_type: 'TreasuryWithdrawals' },
    ];
    const koios = makeKoios({ proposalsByReturnAddress: () => Promise.resolve(proposals) });

    const result = await resolveProposer(koios, STAKE_ADDR);

    expect(result.isProposer).toBe(true);
    expect(result.proposalIds).toEqual(['gov_action1def']);
  });

  it('returns isProposer false and empty proposalIds when no proposals are returned', async () => {
    const koios = makeKoios({ proposalsByReturnAddress: () => Promise.resolve([]) });
    const result = await resolveProposer(koios, STAKE_ADDR);
    expect(result.isProposer).toBe(false);
    expect(result.proposalIds).toEqual([]);
  });

  it('returns isProposer false when no entry has a matching return_address', async () => {
    const proposals = [
      { proposal_id: 'gov_action1abc', return_address: 'stake1differentaddr', proposal_type: 'InfoAction' },
    ];
    const koios = makeKoios({ proposalsByReturnAddress: () => Promise.resolve(proposals) });

    const result = await resolveProposer(koios, STAKE_ADDR);

    expect(result.isProposer).toBe(false);
    expect(result.proposalIds).toEqual([]);
  });
});

// --- resolveSpo (Calidus) ---

describe('resolveSpo', () => {
  it('returns isSpo true with the pool id when the calidus key resolves to a registered pool', async () => {
    const koios = makeKoios({ poolCalidusKey: () => Promise.resolve(calidusRow()) });
    const result = await resolveSpo(koios, CALIDUS_PUBKEY);
    expect(result.isSpo).toBe(true);
    expect(result.poolId).toBe(POOL_ID);
  });

  it('returns isSpo false when the calidus key is unknown (null)', async () => {
    const koios = makeKoios({ poolCalidusKey: () => Promise.resolve(null) });
    const result = await resolveSpo(koios, CALIDUS_PUBKEY);
    expect(result.isSpo).toBe(false);
    expect(result.poolId).toBeUndefined();
  });

  it('returns isSpo false when the registration is revoked (registered=false)', async () => {
    const koios = makeKoios({ poolCalidusKey: () => Promise.resolve(calidusRow({ registered: false })) });
    const result = await resolveSpo(koios, CALIDUS_PUBKEY);
    expect(result.isSpo).toBe(false);
  });

  it('returns isSpo false when the pool itself is not registered (e.g. retired)', async () => {
    const koios = makeKoios({ poolCalidusKey: () => Promise.resolve(calidusRow({ pool_status: 'retired' })) });
    const result = await resolveSpo(koios, CALIDUS_PUBKEY);
    expect(result.isSpo).toBe(false);
  });

  it('defense in depth: returns isSpo false when Koios returns a row for a different pubkey', async () => {
    // A misbehaving or cached Koios response whose calidus_pub_key does not match
    // the queried key must not grant SPO status.
    const koios = makeKoios({
      poolCalidusKey: () => Promise.resolve(calidusRow({ calidus_pub_key: 'deadbeef'.repeat(8) })),
    });
    const result = await resolveSpo(koios, CALIDUS_PUBKEY);
    expect(result.isSpo).toBe(false);
  });

  it('matches case-insensitively on the pubkey hex', async () => {
    const koios = makeKoios({
      poolCalidusKey: () => Promise.resolve(calidusRow({ calidus_pub_key: CALIDUS_PUBKEY.toUpperCase() })),
    });
    const result = await resolveSpo(koios, CALIDUS_PUBKEY);
    expect(result.isSpo).toBe(true);
    expect(result.poolId).toBe(POOL_ID);
  });
});

// --- resolveCc (committee hot key) ---

describe('resolveCc', () => {
  it('returns isCc true with the hot/cold ids for an authorized key-based member', async () => {
    const koios = makeKoios({ committeeInfo: () => Promise.resolve([ccMember()]) });
    const result = await resolveCc(koios, CC_HOT_HEX);
    expect(result.isCc).toBe(true);
    expect(result.ccHotId).toBe(CC_HOT_ID);
  });

  it('returns isCc false when the hash is not in the committee', async () => {
    const koios = makeKoios({ committeeInfo: () => Promise.resolve([ccMember({ cc_hot_hex: 'aa'.repeat(28) })]) });
    const result = await resolveCc(koios, CC_HOT_HEX);
    expect(result.isCc).toBe(false);
  });

  it('returns isCc false when the matching member is not authorized', async () => {
    const koios = makeKoios({
      committeeInfo: () => Promise.resolve([ccMember({ status: 'not_authorized' })]),
    });
    const result = await resolveCc(koios, CC_HOT_HEX);
    expect(result.isCc).toBe(false);
  });

  it('returns isCc false when the matching credential is a native script (not key-based)', async () => {
    // v1 supports key-based credentials only; script CC hot credentials are rejected.
    const koios = makeKoios({
      committeeInfo: () => Promise.resolve([ccMember({ cc_hot_has_script: true })]),
    });
    const result = await resolveCc(koios, CC_HOT_HEX);
    expect(result.isCc).toBe(false);
  });

  it('returns isCc false when there is no committee at all (empty)', async () => {
    const koios = makeKoios({ committeeInfo: () => Promise.resolve([]) });
    const result = await resolveCc(koios, CC_HOT_HEX);
    expect(result.isCc).toBe(false);
  });

  it('matches case-insensitively on the credential hash', async () => {
    const koios = makeKoios({
      committeeInfo: () => Promise.resolve([ccMember({ cc_hot_hex: CC_HOT_HEX.toUpperCase() })]),
    });
    const result = await resolveCc(koios, CC_HOT_HEX);
    expect(result.isCc).toBe(true);
  });

  it('returns isCc false when a matched member has no usable credential id (both null)', async () => {
    // Defense in depth: an authorized, key-based member must expose at least one
    // credential id for the account identity; otherwise reject rather than mint a
    // session with no stable id.
    const koios = makeKoios({
      committeeInfo: () => Promise.resolve([ccMember({ cc_hot_id: null, cc_cold_id: null })]),
    });
    const result = await resolveCc(koios, CC_HOT_HEX);
    expect(result.isCc).toBe(false);
  });
});

// --- resolveScriptDRep ---

const SCRIPT_DREP_ID = 'drep1yvsah2upqmwdtea8c37pac2aw3lv6z7qggcu76243p72msqjnp259';
const SCRIPT_HASH = '21dbab8106dcd5e7a7c47c1ee15d747ecd0bc04231cf6955887cadc0';
const MEMBER_KH = 'e4569cc95f7744c6d39dfa15384e5283fa2dbb39b6fea279621f504f';

function scriptInfoFixture(overrides: Partial<ScriptInfo> = {}): ScriptInfo {
  return {
    script_hash: SCRIPT_HASH,
    type: 'timelock',
    value: { type: 'any', scripts: [{ type: 'sig', keyHash: MEMBER_KH }] },
    ...overrides,
  } as ScriptInfo;
}

describe('resolveScriptDRep', () => {
  it('returns isMember true when the drep is an active script and the key is a sig leaf', async () => {
    const koios = makeKoios({
      drepInfo: () => Promise.resolve(drepFixture({ has_script: true, drep_id: SCRIPT_DREP_ID })),
      scriptInfo: () => Promise.resolve(scriptInfoFixture()),
    });
    const result = await resolveScriptDRep(koios, SCRIPT_DREP_ID, MEMBER_KH);
    expect(result.isMember).toBe(true);
  });

  it('rejects a key that is not a sig leaf', async () => {
    const koios = makeKoios({
      drepInfo: () => Promise.resolve(drepFixture({ has_script: true, drep_id: SCRIPT_DREP_ID })),
      scriptInfo: () => Promise.resolve(scriptInfoFixture()),
    });
    const result = await resolveScriptDRep(koios, SCRIPT_DREP_ID, 'aa'.repeat(28));
    expect(result.isMember).toBe(false);
    expect(result.reason).toBe('not a signer');
  });

  it('rejects when the returned script does not hash to the credential (defense in depth)', async () => {
    const koios = makeKoios({
      drepInfo: () => Promise.resolve(drepFixture({ has_script: true, drep_id: SCRIPT_DREP_ID })),
      scriptInfo: () =>
        Promise.resolve(scriptInfoFixture({ value: { type: 'any', scripts: [{ type: 'sig', keyHash: 'cc'.repeat(28) }] } })),
    });
    const result = await resolveScriptDRep(koios, SCRIPT_DREP_ID, 'cc'.repeat(28));
    expect(result.isMember).toBe(false);
    expect(result.reason).toBe('script hash mismatch');
  });

  it('rejects a Plutus / unsupported script', async () => {
    const koios = makeKoios({
      drepInfo: () => Promise.resolve(drepFixture({ has_script: true, drep_id: SCRIPT_DREP_ID })),
      scriptInfo: () => Promise.resolve(scriptInfoFixture({ type: 'plutusV2', value: null })),
    });
    const result = await resolveScriptDRep(koios, SCRIPT_DREP_ID, MEMBER_KH);
    expect(result.isMember).toBe(false);
    expect(result.reason).toBe('unsupported script');
  });

  it('rejects a key-form drep id in the script field by its form (not a script id)', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture({ has_script: false })) });
    const result = await resolveScriptDRep(koios, DREP_ID, MEMBER_KH);
    expect(result.isMember).toBe(false);
    expect(result.reason).toBe('not a script id');
  });

  it('rejects an unregistered key-form drep id as "not a script id" (no Koios round trip needed)', async () => {
    // The id form (header 0x22) already tells us it is the wrong kind, so an
    // unregistered key-DRep id still gets the actionable reason rather than "not found".
    const koios = makeKoios({ drepInfo: () => Promise.resolve(null) });
    const result = await resolveScriptDRep(koios, DREP_ID, MEMBER_KH);
    expect(result.isMember).toBe(false);
    expect(result.reason).toBe('not a script id');
  });

  it('rejects a script-form id whose on-chain DRep is not a script', async () => {
    const koios = makeKoios({ drepInfo: () => Promise.resolve(drepFixture({ has_script: false, drep_id: SCRIPT_DREP_ID })) });
    const result = await resolveScriptDRep(koios, SCRIPT_DREP_ID, MEMBER_KH);
    expect(result.isMember).toBe(false);
    expect(result.reason).toBe('not a script drep');
  });
});
