import { describe, it, expect } from 'vitest';
import { assignHandles, planSeed, type HandleCandidate } from './assign.js';

const c = (drepId: string, name: string | null, registeredAt: number | null): HandleCandidate => ({ drepId, name, registeredAt });

describe('assignHandles', () => {
  it('orders by registration, the earlier DRep wins a collision', () => {
    const r = assignHandles([c('B', '8Ball', 200), c('A', '8Ball', 100)], new Set());
    expect(r.assigned).toEqual([{ drepId: 'A', handle: '8ball' }]);
    expect(r.skipped).toEqual([{ drepId: 'B', base: '8ball', reason: 'taken' }]);
  });
  it('breaks equal registration times by drep id', () => {
    const r = assignHandles([c('B', 'Same', 1), c('A', 'Same', 1)], new Set());
    expect(r.assigned[0].drepId).toBe('A');
  });
  it('skips names without a base, reserved names, short names and taken handles', () => {
    const r = assignHandles(
      [c('A', '忠実', 1), c('B', 'EMURGO', 2), c('C', 'ab', 3), c('D', 'Taken One', 4)],
      new Set(['taken-one']),
    );
    expect(r.assigned).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['no_base', 'reserved', 'length', 'taken']);
  });
  it('gives the grandfathered short handle to its owner only', () => {
    const P = 'drep1yftc8zs7gjcj4a9nxzplz4wg6cwweya0kxp8adnw59vsyrqvrysud';
    const r = assignHandles([c('X', 'P', 1), c(P, 'P', 2)], new Set());
    expect(r.assigned).toEqual([{ drepId: P, handle: 'p' }]);
  });
});

describe('planSeed', () => {
  const baseline = { bases: { adatainment: ['T'], '8ball': ['S', 'L'] } };
  it('keeps a baseline name with its baseline owner against an older DRep that renamed onto it', () => {
    const plan = planSeed([c('OLD', 'ADAtainment', 1), c('T', 'ADAtainment', 5)], baseline, { assign: {}, skip: [] });
    expect(plan.assigned).toEqual([{ drepId: 'T', handle: 'adatainment', source: 'seed' }]);
    expect(plan.flags).toContainEqual({ handle: 'adatainment', kind: 'collision', drepIds: ['OLD', 'T'] });
  });
  it('flags a baseline name whose baseline owner is gone and assigns by rule', () => {
    const plan = planSeed([c('NEW', 'ADAtainment', 9)], baseline, { assign: {}, skip: [] });
    expect(plan.assigned).toEqual([{ drepId: 'NEW', handle: 'adatainment', source: 'seed' }]);
    expect(plan.flags).toContainEqual({ handle: 'adatainment', kind: 'owner_changed', drepIds: ['NEW'] });
  });
  it('applies overrides last, including for reserved handles', () => {
    const plan = planSeed(
      [c('S', '8Ball', 1), c('L', '8Ball', 2), c('CF', 'Cardano Foundation', 3)],
      baseline,
      { assign: { '8ball': 'L', 'cardano-foundation': 'CF' }, skip: [] },
    );
    expect(plan.assigned).toContainEqual({ drepId: 'L', handle: '8ball', source: 'manual' });
    expect(plan.assigned).toContainEqual({ drepId: 'CF', handle: 'cardano-foundation', source: 'manual' });
    expect(plan.assigned.find((a) => a.drepId === 'S')).toBeUndefined();
  });
  it('drops a skipped handle and flags DReps without a registration time', () => {
    const plan = planSeed([c('T', 'ADAtainment', 5), c('Z', 'Zed', null)], baseline, { assign: {}, skip: ['adatainment'] });
    expect(plan.assigned).toEqual([{ drepId: 'Z', handle: 'zed', source: 'seed' }]);
    expect(plan.flags).toContainEqual({ handle: 'zed', kind: 'missing_registered_at', drepIds: ['Z'] });
    expect(plan.flags).toContainEqual({ handle: 'zed', kind: 'not_in_baseline', drepIds: ['Z'] });
  });
  it('flags every skipped candidate so nothing disappears silently from the report', () => {
    const plan = planSeed([c('A', 'ab', 1), c('B', 'drep1xyz', 2)], { bases: {} }, { assign: {}, skip: [] });
    expect(plan.flags).toContainEqual({ handle: 'ab', kind: 'skipped', reason: 'length', drepIds: ['A'] });
    expect(plan.flags).toContainEqual({ handle: 'drep1xyz', kind: 'skipped', reason: 'id_namespace', drepIds: ['B'] });
  });
  it('lists every candidate as decided so the auto path never revisits them', () => {
    const plan = planSeed([c('A', '忠実', 1), c('T', 'ADAtainment', 5)], baseline, { assign: {}, skip: [] });
    expect(plan.decided.sort()).toEqual(['A', 'T']);
  });
});
