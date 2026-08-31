// Equivalence pin for the registry refactor: for every cron kind and gate case,
// the active phase names in order must match what the hand-wired run functions
// executed before. The `when` predicates read only gates and optional bindings,
// so stand-in contexts exercise them without a Workers runtime. The contexts
// are built field-by-field (casts only on opaque runtime handles) so that a new
// context field breaks this file at compile time instead of silently pinning a
// phase list computed from undefined gates.
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

function govCtx(heavy: boolean, opts: { tessera?: boolean } = {}): GovernanceSyncContext {
  return {
    ...core,
    heavy,
    vapid: null,
    telegramBotToken: null,
    tessera: opts.tessera ? ({} as GovernanceSyncContext['tessera']) : null,
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

describe('governancePhases', () => {
  it('runs only discovery, notification dispatch, and cleanup phases on a light tick', () => {
    expect(activePhaseNames(governancePhases, govCtx(false))).toEqual([
      'discovery', 'delegation-fanout', 'webpush', 'telegram', 'post-erasure', 'cip100',
    ]);
  });

  it('adds the tally/backfill/params phases in order on a heavy tick', () => {
    expect(activePhaseNames(governancePhases, govCtx(true))).toEqual([
      'discovery', 'tallies', 'gov-status-times', 'voted-power', 'threshold-backfill',
      'metadata', 'gov-titles', 'post-dates', 'trending', 'params',
      'delegation-fanout', 'webpush', 'telegram', 'delegation-refresh', 'post-erasure', 'cip100',
    ]);
  });

  it('runs the surveys mirror only when the Tessera client is configured', () => {
    expect(activePhaseNames(governancePhases, govCtx(false))).not.toContain('surveys');
    expect(activePhaseNames(governancePhases, govCtx(false, { tessera: true }))).toEqual([
      'discovery', 'surveys', 'delegation-fanout', 'webpush', 'telegram', 'post-erasure', 'cip100',
    ]);
  });

  it('marks exactly discovery as primary and keeps names unique', () => {
    expectSinglePrimaryFirst(governancePhases);
    expectUniqueNames(governancePhases);
  });
});

describe('votePhases', () => {
  it('runs the vote refresh pipeline every tick, badges only hourly', () => {
    expect(activePhaseNames(votePhases, voteCtx())).toEqual([
      'votes', 'pools', 'pool-avatars', 'rationales', 'committee-meta', 'finalized-backfill',
      'committee-pct', 'meta-hash-backfill', 'rationale-text-backfill', 'reconcile-pending', 'expire-multisig',
    ]);
    expect(activePhaseNames(votePhases, voteCtx({ hourly: true }))).toContain('badges');
  });

  it('skips the pool-avatar mirror when the R2 binding is missing', () => {
    expect(activePhaseNames(votePhases, voteCtx({ avatars: false }))).not.toContain('pool-avatars');
  });

  it('marks exactly votes as primary and keeps names unique', () => {
    expectSinglePrimaryFirst(votePhases);
    expectUniqueNames(votePhases);
  });
});

describe('drepPhases', () => {
  it('runs the profile pipeline in order, avatar store only with the R2 binding', () => {
    expect(activePhaseNames(drepPhases, drepCtx())).toEqual([
      'dreps', 'voting-power-history', 'drep-stats-digest', 'drep-report-card', 'vote-history-sweep',
      'epoch-stats', 'epoch-stats-backfill',
      'registered-epochs', 'slugs', 'pool-slugs', 'pools', 'avatars',
    ]);
    expect(activePhaseNames(drepPhases, drepCtx({ avatars: false }))).not.toContain('avatars');
  });

  it('marks exactly dreps as primary and keeps names unique', () => {
    expectSinglePrimaryFirst(drepPhases);
    expectUniqueNames(drepPhases);
  });
});
