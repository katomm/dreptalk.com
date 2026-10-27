/// <reference types="@cloudflare/workers-types" />
// The drep-groups conformance suite against the D1 store: randomized schedules with rollbacks,
// rebuilds, forks and lease losses, compared with a full replay by the library's driver, plus
// hand built schedules for the interleavings that matter most for this store.
// DREPTALK_CONFORMANCE_SEEDS=100 runs this file in about 40 to 50 seconds locally (2026-10-27, Apple silicon).
import { env } from 'cloudflare:test';
import type { Budget, ChainInput, Credential, EngineSnapshot, LedgerInput, Pos, Recovery, RegistryState } from 'drep-groups';
import { comparePos, credKey, endOf, posOfCert, refKey, replay } from 'drep-groups';
import {
  type Coverage,
  emptyCoverage,
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
import { D1DriverStore } from '../__tests__/d1DriverStore.js';
import { isMarkerTx } from './ingest.js';

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

  it.todo('projects every group, member and retained verdict like engineProjection after the jobs drained');
});

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
