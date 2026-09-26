// Gating rules of the three phase registries. The `when` predicates read only
// gates and optional bindings, so stand-in contexts exercise them without a
// Workers runtime. The tests assert the rules (which gate enables which phase,
// the orderings that matter) instead of full phase lists, so adding an
// ungated phase needs no edit here. The contexts are built field-by-field
// (casts only on opaque runtime handles) so that a new context field breaks
// this file at compile time instead of silently evaluating undefined gates.
import { describe, it, expect } from 'vitest';
import type { NetworkConfig } from '../../config/network.js';
import type { CoreSyncContext, GovSyncKoios } from './context.js';
import { activePhaseNames } from './registry.js';
import { governancePhases, type GovernanceSyncContext } from './governance.js';
import { votePhases, type VoteSyncContext } from './votes.js';
import { drepPhases, initialDrepSyncState, type DrepSyncContext } from './dreps.js';

const R2_STUB = {} as R2Bucket;

const core: CoreSyncContext = {
  db: {} as D1Database,
  koios: {} as GovSyncKoios,
  cfg: {} as NetworkConfig,
  now: 0,
};

function govCtx(
  heavy: boolean,
  opts: { tessera?: boolean; pinGc?: boolean; site?: boolean } = {},
): GovernanceSyncContext {
  return {
    ...core,
    heavy,
    vapid: null,
    telegramBotToken: null,
    tessera: opts.tessera ? ({} as GovernanceSyncContext['tessera']) : null,
    state: { mirrorHealthy: false },
    pinGc: opts.pinGc ? { groupId: 'grp', jwt: 'jwt' } : null,
    site: opts.site ? { fetch: async () => new Response() } : null,
  };
}

function voteCtx(opts: { hourly?: boolean; avatars?: boolean } = {}): VoteSyncContext {
  return {
    ...core,
    hourly: opts.hourly ?? false,
    avatars: opts.avatars === false ? null : R2_STUB,
    downscale: undefined,
  };
}

function drepCtx(opts: { avatars?: boolean } = {}): DrepSyncContext {
  return {
    ...core,
    avatars: opts.avatars === false ? null : R2_STUB,
    downscale: undefined,
    state: initialDrepSyncState(),
  };
}

function expectSinglePrimaryFirst(defs: readonly { name: string; primary?: boolean }[]) {
  expect(defs.filter((d) => d.primary).map((d) => d.name)).toEqual([defs[0].name]);
}

function expectUniqueNames(defs: readonly { name: string }[]) {
  const all = defs.map((d) => d.name);
  expect(new Set(all).size).toBe(all.length);
}

function expectBefore(names: string[], first: string, later: string) {
  expect(names, `${first} is active`).toContain(first);
  expect(names, `${later} is active`).toContain(later);
  expect(names.indexOf(first), `${first} runs before ${later}`).toBeLessThan(names.indexOf(later));
}

const DISPATCH = ['delegation-fanout', 'webpush', 'telegram'];

describe('governancePhases', () => {
  const allGates = govCtx(true, { tessera: true, pinGc: true, site: true });

  it('reaches every registered phase when all gates are open', () => {
    expect(activePhaseNames(governancePhases, allGates)).toEqual(governancePhases.map((d) => d.name));
  });

  it('runs discovery and notification dispatch on every tick, the heavy phases only on a heavy tick', () => {
    const light = activePhaseNames(governancePhases, govCtx(false));
    const heavy = activePhaseNames(governancePhases, govCtx(true));
    for (const name of ['discovery', ...DISPATCH]) expect(light).toContain(name);
    // A heavy tick only adds phases, it never drops one the light tick runs.
    for (const name of light) expect(heavy).toContain(name);
    for (const name of ['tallies', 'metadata', 'params', 'delegation-refresh']) {
      expect(light).not.toContain(name);
      expect(heavy).toContain(name);
    }
  });

  it('drains the delegation fan-out before the webpush and telegram dispatch', () => {
    const names = activePhaseNames(governancePhases, govCtx(false));
    expectBefore(names, 'delegation-fanout', 'webpush');
    expectBefore(names, 'delegation-fanout', 'telegram');
  });

  it('announces review editions before the dispatch phases, on heavy ticks with the app binding', () => {
    const heavy = activePhaseNames(governancePhases, govCtx(true, { site: true }));
    for (const name of DISPATCH) expectBefore(heavy, 'review-announce', name);
    expect(activePhaseNames(governancePhases, govCtx(false, { site: true }))).not.toContain('review-announce');
    expect(activePhaseNames(governancePhases, govCtx(true))).not.toContain('review-announce');
  });

  it('keeps the documented data dependencies in order', () => {
    const names = activePhaseNames(governancePhases, govCtx(true, { pinGc: true }));
    // A title recovered by metadata this run reaches its topic in the same run.
    expectBefore(names, 'metadata', 'gov-titles');
    // A document confirmed by metadata this run is never a pin-gc candidate.
    expectBefore(names, 'metadata', 'pin-gc');
    // Trending folds in the tallies and post dates written this run.
    expectBefore(names, 'tallies', 'trending');
    expectBefore(names, 'post-dates', 'trending');
  });

  it('runs the surveys mirror only when the Tessera client is configured', () => {
    expect(activePhaseNames(governancePhases, govCtx(false))).not.toContain('surveys');
    expect(activePhaseNames(governancePhases, govCtx(true))).not.toContain('surveys');
    expect(activePhaseNames(governancePhases, govCtx(false, { tessera: true }))).toContain('surveys');
  });

  it('runs the pin collector only on a heavy tick with a group and token configured', () => {
    // Unconfigured is the default everywhere today, so the phase must be absent
    // from the ordinary heavy tick rather than present and self-skipping.
    expect(activePhaseNames(governancePhases, govCtx(true))).not.toContain('pin-gc');
    expect(activePhaseNames(governancePhases, govCtx(false, { pinGc: true }))).not.toContain('pin-gc');
    expect(activePhaseNames(governancePhases, govCtx(true, { pinGc: true }))).toContain('pin-gc');
  });

  it('marks exactly discovery as primary and keeps names unique', () => {
    expect(governancePhases[0].name).toBe('discovery');
    expectSinglePrimaryFirst(governancePhases);
    expectUniqueNames(governancePhases);
  });
});

describe('votePhases', () => {
  it('reaches every registered phase on an hourly tick with the R2 binding', () => {
    expect(activePhaseNames(votePhases, voteCtx({ hourly: true }))).toEqual(votePhases.map((d) => d.name));
  });

  it('runs badges only on the hourly tick', () => {
    expect(activePhaseNames(votePhases, voteCtx())).not.toContain('badges');
    expect(activePhaseNames(votePhases, voteCtx({ hourly: true }))).toContain('badges');
  });

  it('skips the pool-avatar mirror when the R2 binding is missing', () => {
    expect(activePhaseNames(votePhases, voteCtx())).toContain('pool-avatars');
    expect(activePhaseNames(votePhases, voteCtx({ avatars: false }))).not.toContain('pool-avatars');
  });

  it('marks exactly votes as primary and keeps names unique', () => {
    expect(votePhases[0].name).toBe('votes');
    expectSinglePrimaryFirst(votePhases);
    expectUniqueNames(votePhases);
  });
});

describe('drepPhases', () => {
  it('reaches every registered phase with the R2 binding', () => {
    expect(activePhaseNames(drepPhases, drepCtx())).toEqual(drepPhases.map((d) => d.name));
  });

  it('skips the R2-backed avatar phases when the binding is missing', () => {
    const withBucket = activePhaseNames(drepPhases, drepCtx());
    const withoutBucket = activePhaseNames(drepPhases, drepCtx({ avatars: false }));
    for (const name of ['avatars', 'avatar-refit']) {
      expect(withBucket).toContain(name);
      expect(withoutBucket).not.toContain(name);
    }
    expect(withoutBucket).toContain('dreps');
  });

  it('computes the epoch stats after the vote-history sweep of the same run', () => {
    expectBefore(activePhaseNames(drepPhases, drepCtx()), 'vote-history-sweep', 'epoch-stats');
  });

  it('marks exactly dreps as primary and keeps names unique', () => {
    expect(drepPhases[0].name).toBe('dreps');
    expectSinglePrimaryFirst(drepPhases);
    expectUniqueNames(drepPhases);
  });
});
