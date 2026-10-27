/// <reference types="@cloudflare/workers-types" />
// The drep-groups conformance suite against the D1 store: randomized schedules with rollbacks,
// rebuilds, forks and lease losses, compared with a full replay by the library's driver, plus
// hand built schedules for the interleavings that matter most for this store.
// DREPTALK_CONFORMANCE_SEEDS=100 runs this file in about 40 to 50 seconds locally (2026-10-27, Apple silicon).
import { env } from 'cloudflare:test';
import type { Budget, ChainInput, Credential, EngineSnapshot, EventRef, LedgerInput, Pos, Recovery, RegistryState } from 'drep-groups';
import { comparePos, credKey, endOf, posOfCert, refKey, replay, runEngine } from 'drep-groups';
import {
  type Coverage,
  type DisplayProjection,
  emptyCoverage,
  engineProjection,
  generateChain,
  generateSchedule,
  mergeCoverage,
  runSchedule,
  type ScheduleResult,
  type ScheduleStep,
} from 'drep-groups/conformance';
import { describe, expect, it } from 'vitest';
import { bindCountingDb } from '../../db/__tests__/bindCountingDb.js';
import { D1_MAX_BINDS } from '../../db/sql.js';
import { getGroup, listMembers, listVerdicts } from '../../db/drepGroups.js';
import { UNLIMITED } from '../../sync/queryBudget.js';
import { D1DriverStore } from '../__tests__/d1DriverStore.js';
import { GROUP_PAGE_SIZE, MAX_JOB_ROWS_PER_RUN, RETENTION_KEEP_APPLIED, RETENTION_KEEP_NOT_APPLIED } from '../constants.js';
import { drepIdForCredential, groupIdString } from '../ids.js';
import { runJobs } from '../jobs.js';
import { D1Store } from './d1Store.js';
import { isMarkerTx } from './ingest.js';
import { acquireLease, invocationOwner } from './lease.js';
import { pendingRecovery } from './reads.js';
import { openRecovery } from './recovery.js';

const SEEDS = Number(env.DREPTALK_CONFORMANCE_SEEDS);
const chainOpts = { txs: 24, credentials: 5, groups: 4 };
const seen: Coverage[] = [];

// The random seeds complete every credential before the final comparison, so the cases of
// incomplete credentials live in hand built schedules 2 and 5 below. known = 0 is not reachable
// through this adapter, the ingest tests of the gate cover it.
describe('drep-groups conformance on D1', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed} matches replay`, { timeout: 180_000 }, async () => {
      const { db: counted, maxBinds } = bindCountingDb(env.DB);
      const chain = generateChain(seed, chainOpts);
      const result = await runSchedule(
        () => new D1DriverStore(counted),
        chain,
        generateSchedule(seed, chain, { chunks: 4, rollback: 0.6, rebuild: 0.5, fork: 0.25 }),
      );
      expect(maxBinds()).toBeLessThanOrEqual(D1_MAX_BINDS);
      // A finished rebuild leaves no rebuilding note behind.
      expect(await env.DB.prepare('SELECT rebuilding FROM drep_group_meta WHERE id = 1').first()).toEqual({ rebuilding: 0 });
      seen.push(result.coverage);
    });
  }

  it('covers truncations, rebuilds, forks and lease losses across the seeds', () => {
    const c = seen.reduce((a, b) => mergeCoverage(a, b), emptyCoverage());
    expect(c.truncations).toBeGreaterThan(0);
    expect(c.rebuilds + c.forks).toBeGreaterThan(0);
    expect(c.leaseLosses).toBeGreaterThan(0);
    expect(c.cutChecks).toBeGreaterThan(0);
  });

  for (let seed = 1; seed <= 4; seed++) {
    it(`seed ${seed}: the page readers show engineProjection after the jobs drained, also after a truncation`, { timeout: 180_000 }, async () => {
      const chain = generateChain(seed, chainOpts);
      await runSchedule(
        () => new D1DriverStore(env.DB),
        chain,
        generateSchedule(seed, chain, { chunks: 4, rollback: 0.6, rebuild: 0.5, fork: 0.25 }),
      );
      const store = new D1DriverStore(env.DB);
      await store.expireLease();
      const lease = (await acquireLease(env.DB, invocationOwner())) as string;
      await drainJobs(lease);
      await expectPagesShow(engineProjection(await store.snapshot()));

      await openRecovery(env.DB, { kind: 'truncate', above: Math.floor(tipOf(chain) / 2) }, lease);
      for (let runs = 0; (await pendingRecovery(env.DB)) !== null; runs++) {
        if (runs >= 100) throw new Error('the truncation did not finish');
        await runEngine(new D1Store(env.DB), BIG, lease);
      }
      await drainJobs(lease);
      await expectPagesShow(engineProjection(await store.snapshot()));
    });
  }
});

async function drainJobs(lease: string): Promise<void> {
  for (let i = 0; ; i++) {
    if (i >= 100) throw new Error('the jobs did not drain');
    const r = await runJobs(env.DB, lease, { maxRows: MAX_JOB_ROWS_PER_RUN, budget: UNLIMITED, now: 0 });
    if (r.pages === 0) return;
  }
}

/** Every group, its counters, members and retained verdicts as the page readers return them, against the projection. */
async function expectPagesShow(proj: DisplayProjection): Promise<void> {
  const ofGroup = <T extends { group: EventRef | null }>(xs: T[], g: EventRef): T[] => xs.filter((x) => x.group !== null && refKey(x.group) === refKey(g));
  const byKey = <T extends { key: string }>(xs: T[]): T[] => [...xs].sort((a, b) => (a.key < b.key ? -1 : 1));
  const actual = [];
  const expected = [];
  for (const g of proj.groups) {
    const members = ofGroup(proj.instances, g.id);
    const verdicts = ofGroup(proj.verdicts, g.id);
    expected.push({
      group: {
        mode: g.mode,
        status: g.status,
        seq: g.seq.toString(),
        controlHash: g.control,
        admissionHash: g.admission,
        profileUrl: g.profile?.url ?? null,
        profileHash: g.profile?.dataHash ?? null,
        createdHeight: g.createdAt.blockHeight,
        profileSetHeight: g.profileSetAt?.blockHeight ?? null,
        members: members.filter((i) => i.state === 'active').length,
        pending: members.filter((i) => i.state === 'pending').length,
        former: members.filter((i) => i.state === 'closed').length,
        appliedEvents: verdicts.filter((v) => v.valid).length,
        notAppliedEvents: verdicts.filter((v) => !v.valid).length,
        closing: false,
      },
      members: byKey(
        members.map((i) => ({
          key: refKey(i.joinId),
          list: i.state,
          drepId: drepIdForCredential(i.member),
          state: i.state,
          reason: i.reason,
          joinedHeight: i.joinedAt.blockHeight,
          approvedHeight: i.approvedAt?.blockHeight ?? null,
          closedHeight: i.closedAt?.blockHeight ?? null,
        })),
      ),
      verdicts: byKey(
        verdicts.map((v) => ({ key: refKey(v.ref), tag: v.tag, valid: v.valid, reason: v.reason, blockHeight: v.at.blockHeight })),
      ),
    });
    const row = await getGroup(env.DB, groupIdString(g.id));
    if (row === null) throw new Error(`group ${refKey(g.id)} not readable`);
    const listed = [];
    for (const [kind, state] of [['active', 'active'], ['pending', 'pending'], ['former', 'closed']] as const) {
      for (let after: string | null = null; ; ) {
        const page = await listMembers(env.DB, g.id, kind, after, GROUP_PAGE_SIZE);
        // The list a row is on is its counted_as cache, the state is effectiveClose: both agree once the jobs drained.
        listed.push(...page.map((m) => ({ ...m, list: state })));
        if (page.length < GROUP_PAGE_SIZE) break;
        after = page[page.length - 1].key;
      }
    }
    const retained = [...(await listVerdicts(env.DB, g.id, true, RETENTION_KEEP_APPLIED)), ...(await listVerdicts(env.DB, g.id, false, RETENTION_KEEP_NOT_APPLIED))];
    actual.push({
      group: {
        mode: row.mode,
        status: row.status,
        seq: row.seq,
        controlHash: row.controlHash,
        admissionHash: row.admissionHash,
        profileUrl: row.profileUrl,
        profileHash: row.profileHash,
        createdHeight: row.createdHeight,
        profileSetHeight: row.profileSetHeight,
        members: row.members,
        pending: row.pending,
        former: row.former,
        appliedEvents: row.appliedEvents,
        notAppliedEvents: row.notAppliedEvents,
        closing: row.closing,
      },
      members: byKey(
        listed.map((m) => ({
          key: m.joinId,
          list: m.list,
          drepId: m.drepId,
          state: m.state,
          reason: m.reason,
          joinedHeight: m.joinedHeight,
          approvedHeight: m.approvedHeight,
          closedHeight: m.closedHeight,
        })),
      ),
      verdicts: byKey(
        retained.map((v) => ({ key: `${v.txHash}#${v.eventIndex}`, tag: v.tag, valid: v.valid, reason: v.reason, blockHeight: v.blockHeight })),
      ),
    });
  }
  expect(actual).toEqual(expected);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM drep_groups').first()).toEqual({ n: proj.groups.length });
}

const BIG: Budget = {
  controlTxs: 1000,
  controlBytes: 10_000_000,
  credentialUnits: 1000,
  credentialInputs: 10_000,
  truncateRows: 100_000,
  resetRows: 100_000,
};
const ONE_ROW: Budget = { ...BIG, resetRows: 1, truncateRows: 1 };
const run = (budget = BIG): ScheduleStep => ({ kind: 'run', budget });
const heightOf = (x: ChainInput): number => (x.kind === 'tx' ? x.tx.blockHeight : x.input.blockHeight);
const tipOf = (chain: ChainInput[]): number => chain.reduce((h, x) => Math.max(h, heightOf(x)), 0);
const ledgerOf = (chain: ChainInput[]): LedgerInput[] => chain.flatMap((x) => (x.kind === 'ledger' ? [x.input] : []));
const sameCred = (a: Credential, b: Credential): boolean => credKey(a) === credKey(b);

/** Whether the credential has a ledger row or an event verdict strictly after `p`. */
function inputAfter(chain: ChainInput[], s: RegistryState, c: Credential, p: Pos): boolean {
  return (
    ledgerOf(chain).some((l) => sameCred(l.credential, c) && comparePos(posOfCert(l), p) > 0) ||
    s.verdicts.some((v) => v.subject !== null && sameCred(v.subject, c) && comparePos(v.at, p) > 0)
  );
}

/** The first generated chain the predicate accepts, with what it found. */
function findChain<T>(pick: (chain: ChainInput[], s: RegistryState) => T | null): { chain: ChainInput[]; found: T } {
  for (let seed = 1; seed <= 500; seed++) {
    const chain = generateChain(seed, { txs: 40, credentials: 6, groups: 4 });
    const found = pick(chain, replay(chain));
    if (found !== null) return { chain, found };
  }
  throw new Error('no generated chain has the shape');
}

// The pending recovery at the time of each snapshot, so a checkpoint can assert it.
const pendingAt = new WeakMap<EngineSnapshot, Recovery | null>();
class ProbedStore extends D1DriverStore {
  override async snapshot(): Promise<EngineSnapshot> {
    const s = await super.snapshot();
    pendingAt.set(s, await this.pendingRecovery());
    return s;
  }
}

async function runOnD1(chain: ChainInput[], steps: ScheduleStep[]): Promise<ScheduleResult> {
  const { db: counted, maxBinds } = bindCountingDb(env.DB);
  const result = await runSchedule(() => new ProbedStore(counted), chain, steps);
  expect(maxBinds()).toBeLessThanOrEqual(D1_MAX_BINDS);
  return result;
}

function checkpoint(r: ScheduleResult, label: string) {
  const c = r.checkpoints.find((x) => x.label === label);
  if (!c) throw new Error(`no checkpoint ${label}`);
  return c.snapshot;
}

describe('hand built schedules on D1', () => {
  it('truncates for a late unreg below applied-through from the reader overlap', { timeout: 60_000 }, async () => {
    const { chain, found: late } = findChain(
      (chain, s) => ledgerOf(chain).find((u) => u.kind === 'unreg' && inputAfter(chain, s, u.credential, posOfCert(u))) ?? null,
    );
    const tip = tipOf(chain);
    const isLate = (x: ChainInput): boolean =>
      x.kind === 'ledger' && x.input.txHash === late.txHash && x.input.certIndex === late.certIndex;
    // The overlap delivers the late row together with rows of the credential stored already.
    const overlap = chain.filter((x) => x.kind === 'ledger' && sameCred(x.input.credential, late.credential));
    const r = await runOnD1(chain, [
      { kind: 'deliver', inputs: chain.filter((x) => !isLate(x)) },
      { kind: 'frontiers', L: tip, R: tip },
      run(),
      run(),
      { kind: 'deliver', inputs: overlap },
      run(),
    ]);
    expect(r.coverage.truncations).toBeGreaterThan(0);
  });

  it('commits joins after the dissolve, a queued leave below it and a join as last input', { timeout: 60_000 }, async () => {
    // A dissolved group with an instance left below the dissolve and one closed by the dissolve
    // whose member has no input after its join.
    const { chain, found } = findChain((chain, s) => {
      for (const g of s.groups) {
        if (g.status !== 'dissolved') continue;
        const dissolve = s.verdicts.find((v) => v.tag === 'dissolve' && v.valid && v.group !== null && refKey(v.group) === refKey(g.id));
        if (!dissolve) continue;
        const own = s.instances.filter((i) => refKey(i.group) === refKey(g.id));
        const left = own.find((i) => i.reason === 'left' && i.closedAt !== null && comparePos(i.closedAt, dissolve.at) < 0);
        const last = own.find((i) => i.reason === 'dissolved' && !inputAfter(chain, s, i.member, i.joinedAt));
        if (left && last && !sameCred(left.member, last.member)) return { members: own.map((i) => i.member), left, last };
      }
      return null;
    });
    const tip = tipOf(chain);
    const members = [...new Map(found.members.map((c) => [credKey(c), c])).values()];
    const r = await runOnD1(chain, [
      ...members.map((c): ScheduleStep => ({ kind: 'complete', c, complete: false })),
      { kind: 'deliver', inputs: chain },
      { kind: 'frontiers', L: tip, R: tip },
      run(),
      { kind: 'check', label: 'dissolved' },
      { kind: 'complete', c: found.last.member, complete: true },
      run(),
      { kind: 'complete', c: found.left.member, complete: true },
      run(),
      ...members.map((c): ScheduleStep => ({ kind: 'complete', c, complete: true })),
      run(),
    ]);
    // The group plane passed the dissolve while every member's input still waited.
    const snap = checkpoint(r, 'dissolved');
    expect(snap.frontiers.G).toEqual(endOf(tip));
    const waiting = snap.queue.filter((q) => members.some((c) => sameCred(c, q.subject)));
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((q) => !q.applied)).toBe(true);
  });

  it('opens nothing for a marker below G delivered during a rebuild', { timeout: 60_000 }, async () => {
    const { chain, found: marker } = findChain(
      (chain) => chain.find((x) => x.kind === 'tx' && isMarkerTx(x.tx) && x.tx.blockHeight < tipOf(chain)) ?? null,
    );
    const tip = tipOf(chain);
    const r = await runOnD1(chain, [
      { kind: 'deliver', inputs: chain.filter((x) => x !== marker) },
      { kind: 'frontiers', L: tip, R: tip },
      run(),
      { kind: 'rebuild' },
      run(ONE_ROW),
      { kind: 'check', label: 'rebuilding' },
      { kind: 'deliver', inputs: [marker] },
      run(ONE_ROW),
      run(),
    ]);
    expect(r.coverage.rebuilds).toBeGreaterThan(0);
    // The marker arrived while the rebuild was still open and G above its block.
    const snap = checkpoint(r, 'rebuilding');
    expect(pendingAt.get(snap)).toEqual({ kind: 'rebuild' });
    expect(snap.frontiers.G.blockHeight).toBeGreaterThan(marker.kind === 'tx' ? marker.tx.blockHeight : Number.MAX_SAFE_INTEGER);
  });

  it('applies inputs in block R itself', { timeout: 60_000 }, async () => {
    // A ledger row below the tip, so label txs above its block let G pass R.
    const { chain, found: row } = findChain((chain) => ledgerOf(chain).find((l) => l.blockHeight < tipOf(chain)) ?? null);
    const tip = tipOf(chain);
    const r = await runOnD1(chain, [
      { kind: 'deliver', inputs: chain },
      { kind: 'frontiers', L: tip, R: row.blockHeight },
      run(),
      run(),
      { kind: 'check', label: 'R' },
    ]);
    const applied = checkpoint(r, 'R').appliedThrough.find((a) => sameCred(a.credential, row.credential));
    expect(applied).toBeDefined();
    expect(comparePos(applied?.at ?? endOf(-1), posOfCert(row))).toBeGreaterThanOrEqual(0);
  });

  it('keeps the join of a credential marked incomplete before its first input until its reg', { timeout: 60_000 }, async () => {
    // A member whose every reg lies before its join.
    const { chain, found: c } = findChain((chain, s) => {
      for (const i of s.instances) {
        const regs = ledgerOf(chain).filter((l) => sameCred(l.credential, i.member) && l.kind === 'reg');
        if (regs.length > 0 && regs.every((l) => comparePos(posOfCert(l), i.joinedAt) < 0)) return i.member;
      }
      return null;
    });
    const tip = tipOf(chain);
    const own = (x: ChainInput): boolean => x.kind === 'ledger' && sameCred(x.input.credential, c);
    const r = await runOnD1(chain, [
      { kind: 'complete', c, complete: false },
      { kind: 'deliver', inputs: chain.filter((x) => !own(x)) },
      { kind: 'frontiers', L: tip, R: tip },
      run(),
      { kind: 'check', label: 'waiting' },
      { kind: 'deliver', inputs: chain.filter(own) },
      { kind: 'complete', c, complete: true },
      run(),
    ]);
    const waiting = checkpoint(r, 'waiting').queue.filter((q) => sameCred(q.subject, c));
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((q) => !q.applied)).toBe(true);
  });
});
