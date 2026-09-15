import { describe, expect, it } from 'vitest';
import { Role } from 'cip-179';
import { type TallyRefusalInput, tallyRefusal } from './tallyRefusal.js';

/** A survey the tally has every reason to render figures for. */
function readable(over: Partial<TallyRefusalInput> = {}): TallyRefusalInput {
  return {
    unavailable: false,
    externalContent: false,
    sealed: false,
    finalState: null,
    artifactHash: null,
    eligibleRoles: [Role.DRep],
    lifecycle: 'open',
    definitionReadable: true,
    tallyStale: false,
    hasTally: true,
    powerEpoch: 500,
    ...over,
  };
}

describe('tallyRefusal', () => {
  it('refuses nothing when there are figures to draw', () => {
    expect(tallyRefusal(readable())).toBeNull();
  });

  it('names one reason per state', () => {
    expect(tallyRefusal(readable({ unavailable: true }))).toMatch(/no longer in the index/);
    expect(tallyRefusal(readable({ externalContent: true }))).toMatch(/external document/);
    expect(tallyRefusal(readable({ lifecycle: 'cancelled' }))).toMatch(/cancelled/);
    expect(tallyRefusal(readable({ lifecycle: 'untalliable' }))).toMatch(/invalid under CIP-179/);
    expect(tallyRefusal(readable({ eligibleRoles: [Role.SPO] }))).toMatch(/does not accept DRep/);
    expect(tallyRefusal(readable({ sealed: true }))).toMatch(/timelock-encrypted/);
    expect(tallyRefusal(readable({ definitionReadable: false }))).toMatch(/could not be read/);
    expect(tallyRefusal(readable({ tallyStale: true }))).toMatch(/being recomputed/);
    expect(tallyRefusal(readable({ hasTally: false }))).toMatch(/not produced one/);
    expect(tallyRefusal(readable({ hasTally: false, powerEpoch: null }))).toMatch(
      /no DRep voting power history/,
    );
  });

  it('keeps the survey-state reasons ahead of the tally-state ones', () => {
    // A cancelled survey with no stored reading must not be described as one
    // whose reading is still coming: no pass will ever compute it.
    const both = readable({ lifecycle: 'cancelled', hasTally: false, powerEpoch: null });
    expect(tallyRefusal(both)).toMatch(/cancelled/);
  });

  it('reads a sealed survey once it is finalized with an artifact', () => {
    expect(tallyRefusal(readable({ sealed: true, finalState: 'finalized', artifactHash: 'ab' }))).toBeNull();
    // Finalized but with no artifact hash is the state the tally pass itself
    // refuses on, so it must stay a refusal rather than promise a pass.
    expect(tallyRefusal(readable({ sealed: true, finalState: 'finalized' }))).toMatch(
      /timelock-encrypted/,
    );
  });
});
