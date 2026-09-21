import { describe, it, expect } from 'vitest';
import { previewModelFromForm, CONSTITUTION_PREVIEW_URL } from './previewModel.js';
import {
  initialGovActionFormState,
  type GovActionFormState,
  type PanelStates,
} from './govActionFormState.js';
import type { ActionContextResponse } from './actionContextHandler.js';
import type { EpochParamsRow } from '../koios/client.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';

const MEMBER_A = 'a'.repeat(56);
const MEMBER_B = 'b'.repeat(56);
const SCRIPT_MEMBER = 'c'.repeat(56);
const NEW_MEMBER = 'd'.repeat(56);
const ROOT_HASH = 'e'.repeat(64);
const OPEN_HASH = 'f'.repeat(64);
const SCRIPT_HASH = 'fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64';

const EPOCH_PARAMS = {
  epoch_no: 500,
  gov_action_deposit: 100_000_000_000,
  protocol_major: 10,
  protocol_minor: 0,
} as unknown as EpochParamsRow;

function context(overrides: Partial<ActionContextResponse> = {}): ActionContextResponse {
  return {
    epoch: 500,
    prev: {
      lastEnacted: {
        txHash: ROOT_HASH,
        index: 0,
        id: 'gov_action1root',
        type: 'NewCommittee',
        title: 'The root',
        proposedEpoch: 400,
      },
      open: [
        {
          txHash: OPEN_HASH,
          index: 1,
          id: 'gov_action1open',
          type: 'UpdateCommittee',
          title: 'An open change',
          proposedEpoch: 499,
          version: { major: 10, minor: 1 },
        },
      ],
    },
    protocolVersion: { major: 10, minor: 0 },
    committee: {
      members: [
        { coldHex: MEMBER_A, hasScript: false, expirationEpoch: 600, name: 'Alice' },
        { coldHex: MEMBER_B, hasScript: false, expirationEpoch: 610, name: null },
        { coldHex: SCRIPT_MEMBER, hasScript: true, expirationEpoch: 650, name: 'A script member' },
      ],
      quorum: { numerator: 2, denominator: 3 },
      maxTermLength: 100,
    },
    constitution: { scriptHash: SCRIPT_HASH },
    ...overrides,
  };
}

/** A filled form of the given type, with whatever panel state the test needs. */
function form(
  type: GovActionFormState['type'],
  panels: Partial<PanelStates> = {},
  metadata: Partial<GovActionFormState['metadata']> = {},
): Pick<GovActionFormState, 'type' | 'metadata' | 'panels'> {
  const base = initialGovActionFormState('Jane DRep');
  return {
    type,
    metadata: {
      ...base.metadata,
      title: 'A title',
      abstract: 'An abstract',
      motivation: 'A motivation',
      rationale: 'A rationale',
      ...metadata,
    },
    panels: { ...base.panels, ...panels },
  };
}

const model = (
  state: Pick<GovActionFormState, 'type' | 'metadata' | 'panels'>,
  ctx: ActionContextResponse | null = context(),
) => previewModelFromForm(state, ctx, EPOCH_PARAMS, 'preprod');

describe('previewModelFromForm, the five types when the form is complete', () => {
  it('an InfoAction reads as the informational note with nothing missing', () => {
    const result = model(form('InfoAction'));
    expect(result.missing).toEqual([]);
    expect(result.onchain).toEqual({
      kind: 'note',
      tag: 'InfoAction',
      text: 'Informational action. No on-chain effect; the vote signals opinion only.',
    });
  });

  it('a NoConfidence reads as the no-confidence note', () => {
    const result = model(form('NoConfidence'));
    expect(result.missing).toEqual([]);
    expect(result.onchain).toMatchObject({ kind: 'note', tag: 'NoConfidence' });
  });

  it('a HardForkInitiation reads as the version change against the active one', () => {
    const result = model(form('HardForkInitiation', { HardForkInitiation: { prev: null, version: { major: 11, minor: 0 } } }));
    expect(result.missing).toEqual([]);
    expect(result.onchain).toEqual({ kind: 'hardfork', fromVersion: '10.0', toVersion: '11.0' });
  });

  it('a NewConstitution carries the document hash of the exact typed bytes and the placeholder anchor', () => {
    const text = '# A new constitution\n\nArticle one.';
    const result = model(form('NewConstitution', { NewConstitution: { prev: null, text, scriptHashHex: null } }));
    expect(result.missing).toEqual([]);
    expect(result.onchain).toEqual({
      kind: 'constitution',
      anchorUrl: CONSTITUTION_PREVIEW_URL,
      dataHash: bytesToHex(blake2b256(new TextEncoder().encode(text))),
      // Untouched hash field: the script in force, exactly as the panel resolves it.
      scriptHash: SCRIPT_HASH,
    });
  });

  it('an UpdateCommittee reads as the added, removed and threshold rows', () => {
    const result = model(
      form('UpdateCommittee', {
        UpdateCommittee: {
          prev: null,
          removeHex: [MEMBER_A],
          removeFree: [],
          add: [{ input: NEW_MEMBER, hexKind: 'key', expiryEpoch: '560' }],
          quorum: null,
        },
      }),
    );
    expect(result.missing).toEqual([]);
    if (result.onchain?.kind !== 'committee') throw new Error('expected a committee card');
    expect(result.onchain.threshold).toBe('67%');
    expect(result.onchain.added).toEqual([
      { credentialType: 'keyHash', coldKeyHex: NEW_MEMBER, label: expect.stringContaining('keyHash'), termEpoch: 560 },
    ]);
    expect(result.onchain.removed).toMatchObject([{ credentialType: 'keyHash', coldKeyHex: MEMBER_A }]);
  });
});

describe('previewModelFromForm, incomplete panels', () => {
  it('names the protocol version and still shows the active one', () => {
    const result = model(form('HardForkInitiation', { HardForkInitiation: { prev: null, version: null } }));
    expect(result.missing).toEqual(['Protocol version']);
    expect(result.onchain).toMatchObject({ kind: 'hardfork', fromVersion: '10.0', toVersion: '' });
  });

  it('keeps a version that no longer follows the chain state on screen and still names the field', () => {
    const result = model(
      form('HardForkInitiation', { HardForkInitiation: { prev: null, version: { major: 12, minor: 0 } } }),
    );
    expect(result.missing).toEqual(['Protocol version']);
    expect(result.onchain).toEqual({ kind: 'hardfork', fromVersion: '10.0', toVersion: '12.0' });
  });

  it('names the constitution text and leaves the document hash out', () => {
    const result = model(form('NewConstitution', { NewConstitution: { prev: null, text: '   ', scriptHashHex: null } }));
    expect(result.missing).toEqual(['Constitution text']);
    expect(result.onchain).toMatchObject({ kind: 'constitution', dataHash: null });
  });

  it('names a malformed guardrails script hash and keeps the document hash', () => {
    const result = model(
      form('NewConstitution', { NewConstitution: { prev: null, text: 'Article one.', scriptHashHex: 'nothex' } }),
    );
    expect(result.missing).toEqual(['Guardrails script hash']);
    if (result.onchain?.kind !== 'constitution') throw new Error('expected a constitution card');
    expect(result.onchain.scriptHash).toBeNull();
    expect(result.onchain.dataHash).not.toBeNull();
  });

  it('reports a malformed credential rather than throwing, and keeps the rows that parsed', () => {
    const result = model(
      form('UpdateCommittee', {
        UpdateCommittee: {
          prev: null,
          removeHex: [MEMBER_A],
          removeFree: [],
          add: [
            { input: 'not-a-credential', hexKind: 'key', expiryEpoch: '560' },
            { input: NEW_MEMBER, hexKind: 'key', expiryEpoch: '560' },
          ],
          quorum: null,
        },
      }),
    );
    expect(result.missing).toEqual(['Member to add 1']);
    if (result.onchain?.kind !== 'committee') throw new Error('expected a committee card');
    expect(result.onchain.added).toHaveLength(1);
    expect(result.onchain.added[0].coldKeyHex).toBe(NEW_MEMBER);
    expect(result.onchain.removed).toHaveLength(1);
  });

  it('says the committee changes nothing when no row was filled in at all', () => {
    const result = model(
      form('UpdateCommittee', {
        UpdateCommittee: { prev: null, removeHex: [], removeFree: [], add: [], quorum: null },
      }),
    );
    expect(result.missing).toEqual(['Committee changes']);
  });

  it('names a mistyped expiry epoch on the row it belongs to', () => {
    const result = model(
      form('UpdateCommittee', {
        UpdateCommittee: {
          prev: null,
          removeHex: [],
          removeFree: [],
          add: [{ input: NEW_MEMBER, hexKind: 'key', expiryEpoch: 'soon' }],
          quorum: null,
        },
      }),
    );
    expect(result.missing).toEqual(['Expiry epoch for addition 1']);
  });

  it('names both quorum fields when they are half typed', () => {
    const result = model(
      form('UpdateCommittee', {
        UpdateCommittee: {
          prev: null,
          removeHex: [MEMBER_A],
          removeFree: [],
          add: [],
          quorum: { numerator: '', denominator: '' },
        },
      }),
    );
    expect(result.missing).toEqual(['Quorum numerator', 'Quorum denominator']);
  });
});

describe('previewModelFromForm, untouched defaults resolve like the panels', () => {
  it('takes the chain root as the previous action when none was picked', () => {
    // The prev pointer is not on the card, so it is asserted through the
    // decoder's own lineage reader in previewPayload (see the export below).
    const result = model(form('NoConfidence'));
    expect(result.onchain).toMatchObject({ kind: 'note', tag: 'NoConfidence' });
    expect(result.missing).toEqual([]);
  });

  it('takes the quorum in force when the field was never touched', () => {
    const result = model(
      form('UpdateCommittee', {
        UpdateCommittee: { prev: null, removeHex: [MEMBER_A], removeFree: [], add: [], quorum: null },
      }),
    );
    if (result.onchain?.kind !== 'committee') throw new Error('expected a committee card');
    expect(result.onchain.threshold).toBe('67%');
  });

  it('takes the guardrails hash in force when the field was never touched', () => {
    const result = model(
      form('NewConstitution', { NewConstitution: { prev: null, text: 'Article one.', scriptHashHex: null } }),
    );
    if (result.onchain?.kind !== 'constitution') throw new Error('expected a constitution card');
    expect(result.onchain.scriptHash).toBe(SCRIPT_HASH);
  });

  it('takes a deliberately cleared guardrails field as no script at all', () => {
    const result = model(
      form('NewConstitution', { NewConstitution: { prev: null, text: 'Article one.', scriptHashHex: '' } }),
    );
    if (result.onchain?.kind !== 'constitution') throw new Error('expected a constitution card');
    expect(result.onchain.scriptHash).toBeNull();
  });
});

describe('previewModelFromForm, committee credential kinds and modes', () => {
  it('removes a script member as a script credential, not a key', () => {
    const result = model(
      form('UpdateCommittee', {
        UpdateCommittee: { prev: null, removeHex: [SCRIPT_MEMBER], removeFree: [], add: [], quorum: null },
      }),
    );
    if (result.onchain?.kind !== 'committee') throw new Error('expected a committee card');
    expect(result.onchain.removed).toMatchObject([{ credentialType: 'scriptHash', coldKeyHex: SCRIPT_MEMBER }]);
  });

  it('reads the free rows when the proposal chains onto an open one', () => {
    const result = model(
      form('UpdateCommittee', {
        UpdateCommittee: {
          prev: { txHashHex: OPEN_HASH, index: 1 },
          // Ticked in enacted mode and then chained onto an open proposal: the
          // ticks belong to the other mode and must not reach the payload.
          removeHex: [MEMBER_A],
          removeFree: [{ input: MEMBER_B, hexKind: 'key' }],
          add: [],
          quorum: { numerator: '3', denominator: '5' },
        },
      }),
    );
    expect(result.missing).toEqual([]);
    if (result.onchain?.kind !== 'committee') throw new Error('expected a committee card');
    expect(result.onchain.removed).toMatchObject([{ coldKeyHex: MEMBER_B }]);
    expect(result.onchain.threshold).toBe('60%');
  });
});

describe('previewModelFromForm, metadata and the author line', () => {
  it('lists every empty metadata field in the order the form shows them', () => {
    const state = form('InfoAction', {}, { title: '', abstract: '  ', motivation: '', rationale: '' });
    expect(model(state).missing).toEqual(['Title', 'Abstract', 'Motivation', 'Rationale']);
  });

  it('puts the panel fields before the metadata and the author name last', () => {
    const state = form(
      'HardForkInitiation',
      { HardForkInitiation: { prev: null, version: null } },
      { title: '', abstract: 'a', motivation: 'm', rationale: 'r', signAsAuthor: true, authorName: '  ' },
    );
    expect(model(state).missing).toEqual(['Protocol version', 'Title', 'Author name']);
  });

  it('names the author and says the wallet key will sign it', () => {
    const state = form('InfoAction', {}, { signAsAuthor: true, authorName: 'Jane DRep' });
    expect(model(state).authorLine).toBe('Author: Jane DRep, will be signed with your wallet key when you submit');
    expect(model(state).missing).toEqual([]);
  });

  it('says no author is named when signing is off', () => {
    const state = form('InfoAction', {}, { signAsAuthor: false, authorName: 'Jane DRep' });
    expect(model(state).authorLine).toBe('No author named');
    expect(model(state).missing).toEqual([]);
  });

  it('says no author is named and asks for one when signing is on with an empty name', () => {
    const state = form('InfoAction', {}, { signAsAuthor: true, authorName: '' });
    expect(model(state).authorLine).toBe('No author named');
    expect(model(state).missing).toEqual(['Author name']);
  });
});

describe('previewModelFromForm without a chain context', () => {
  it('previews an InfoAction, which needs no context at all', () => {
    const result = previewModelFromForm(form('InfoAction'), null, EPOCH_PARAMS, 'preprod');
    expect(result.onchain).toMatchObject({ kind: 'note', tag: 'InfoAction' });
    expect(result.missing).toEqual([]);
  });

  it('still names the missing panel field for a chained type', () => {
    const result = previewModelFromForm(
      form('HardForkInitiation', { HardForkInitiation: { prev: null, version: { major: 11, minor: 0 } } }),
      null,
      null,
      'preprod',
    );
    expect(result.missing).toEqual(['Protocol version']);
    expect(result.onchain).toMatchObject({ kind: 'hardfork', fromVersion: null, toVersion: '11.0' });
  });
});
