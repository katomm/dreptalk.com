import { Role } from 'cip-179';
import { describe, expect, it } from 'vitest';
import { EPOCH_LENGTH_SECONDS, resolveNetwork } from '../config/network.js';
import { lifecycleLabel, participationLabel, type SurveyStateInput, surveyState } from './state.js';

const cfg = resolveNetwork('preprod');
const startOf = (epoch: number) =>
  (cfg.epochAnchor.unixSeconds + (epoch - cfg.epochAnchor.epoch) * EPOCH_LENGTH_SECONDS) * 1000;
/** Well inside epoch 300, the row's end epoch. */
const DURING = startOf(300) + 1000;

function row(o: Partial<SurveyStateInput> = {}): SurveyStateInput {
  return {
    endEpoch: 300,
    eligibleRoles: [Role.DRep],
    cancelled: false,
    externalContent: false,
    countedDreps: null,
    finalCountedDreps: null,
    finalState: null,
    unavailable: false,
    ...o,
  };
}

describe('surveyState lifecycle', () => {
  it('is open through end_epoch inclusive and closed from the next epoch', () => {
    // Last second of epoch 300 (the inclusive deadline).
    expect(surveyState(row(), startOf(301) - 1000, cfg).lifecycle).toBe('open');
    expect(surveyState(row(), startOf(301), cfg).lifecycle).toBe('closed');
  });

  it('cancelled wins over the clock, and an untalliable decision over both', () => {
    expect(surveyState(row({ cancelled: true }), startOf(299), cfg).lifecycle).toBe('cancelled');
    const invalid = row({ cancelled: true, finalState: 'untalliable' });
    expect(surveyState(invalid, startOf(299), cfg).lifecycle).toBe('untalliable');
    expect(surveyState(invalid, startOf(305), cfg).lifecycle).toBe('untalliable');
  });

  it('names each lifecycle once', () => {
    expect(lifecycleLabel('open')).toBe('Open');
    expect(lifecycleLabel('closed')).toBe('Closed');
    expect(lifecycleLabel('cancelled')).toBe('Cancelled');
    expect(lifecycleLabel('untalliable')).toBe('Invalid definition');
  });
});

describe('surveyState answerable', () => {
  it('is open, held, DRep-eligible and not external-content — all four', () => {
    expect(surveyState(row(), DURING, cfg).answerable).toBe(true);
    expect(surveyState(row(), startOf(301), cfg).answerable).toBe(false);
    expect(surveyState(row({ cancelled: true }), DURING, cfg).answerable).toBe(false);
    expect(surveyState(row({ finalState: 'untalliable' }), DURING, cfg).answerable).toBe(false);
    expect(surveyState(row({ unavailable: true }), DURING, cfg).answerable).toBe(false);
    expect(surveyState(row({ externalContent: true }), DURING, cfg).answerable).toBe(false);
    expect(surveyState(row({ eligibleRoles: [Role.SPO] }), DURING, cfg).answerable).toBe(false);
    expect(surveyState(row({ eligibleRoles: [Role.SPO, Role.DRep] }), DURING, cfg).answerable).toBe(
      true,
    );
  });
});

describe('surveyState participation', () => {
  const p = (o: Partial<SurveyStateInput>) => surveyState(row(o), DURING, cfg).participation;

  it('prefers the artifact figure, then the in-window one, then says what is coming', () => {
    expect(p({ countedDreps: 3, finalCountedDreps: 2, finalState: 'finalized' })).toEqual({
      kind: 'countedAtClose',
      count: 2,
    });
    // Decided but the artifact not read yet: the last in-window figure still
    // stands, labelled as what it is.
    expect(p({ countedDreps: 3, finalState: 'finalized' })).toEqual({ kind: 'counted', count: 3 });
    expect(p({ countedDreps: 0 })).toEqual({ kind: 'counted', count: 0 });
    expect(p({})).toEqual({ kind: 'pending' });
    expect(p({ finalState: 'finalized' })).toEqual({ kind: 'pending' });
  });

  it('has no figure for a cancelled or untalliable survey, whatever was counted in-window', () => {
    expect(p({ countedDreps: 3, finalState: 'cancelled' })).toEqual({ kind: 'none' });
    expect(p({ countedDreps: 3, finalState: 'untalliable' })).toEqual({ kind: 'none' });
    // A state this code predates is decided for good with no artifact read:
    // no count rather than a stale in-window one.
    expect(p({ countedDreps: 3, finalState: 'vetoed' })).toEqual({ kind: 'none' });
  });

  it('a withdrawn record is unavailable whatever it stored', () => {
    expect(p({ countedDreps: 3, finalCountedDreps: 3, unavailable: true })).toEqual({
      kind: 'unavailable',
    });
  });

  it('words each kind once', () => {
    expect(participationLabel({ kind: 'counted', count: 1 })).toBe('1 DRep response counted');
    expect(participationLabel({ kind: 'countedAtClose', count: 2 })).toBe(
      '2 DRep responses counted at close',
    );
    expect(participationLabel({ kind: 'pending' })).toBe('count pending');
    expect(participationLabel({ kind: 'unavailable' })).toBe('count unavailable');
    expect(participationLabel({ kind: 'none' })).toBe('no count');
  });
});
