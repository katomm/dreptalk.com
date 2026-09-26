// Pure handle assignment for drep.link. assignHandles serves the gov-sync phase
// (first come among free handles, in registration order). planSeed serves the
// one-time launch seed: it protects the 2026-09-25 baseline owners and reports
// everything Tommy has to look at before the seed is applied.
import { slugBase } from '../slug.js';
import { HANDLE_MAX, validateHandle } from './handle.js';

/**
 * The handle a name turns into: the slug base, but a name longer than the
 * handle limit is cut at the last word boundary instead of mid-word
 * ("...-from-carda" becomes "...-from"). A single overlong word is cut hard.
 */
export function handleBase(name: string): string {
  const full = slugBase(name, Number.POSITIVE_INFINITY);
  if (full.length <= HANDLE_MAX) return full;
  const cut = full.lastIndexOf('-', HANDLE_MAX);
  return cut > 0 ? full.slice(0, cut) : full.slice(0, HANDLE_MAX);
}

export interface HandleCandidate { drepId: string; name: string | null; registeredAt: number | null }
export type SkipReason = 'no_base' | 'shape' | 'length' | 'id_namespace' | 'reserved' | 'taken';
export interface AssignResult {
  assigned: { drepId: string; handle: string }[];
  skipped: { drepId: string; base: string; reason: SkipReason }[];
}

function byRegistration(a: HandleCandidate, b: HandleCandidate): number {
  const ra = a.registeredAt ?? Number.MAX_SAFE_INTEGER;
  const rb = b.registeredAt ?? Number.MAX_SAFE_INTEGER;
  return ra - rb || (a.drepId < b.drepId ? -1 : a.drepId > b.drepId ? 1 : 0);
}

/** Assigns free handles in registration order. Mutates `taken` as handles are handed out. */
export function assignHandles(rows: HandleCandidate[], taken: Set<string>): AssignResult {
  const out: AssignResult = { assigned: [], skipped: [] };
  for (const row of [...rows].sort(byRegistration)) {
    const base = row.name ? handleBase(row.name) : '';
    if (!base) {
      out.skipped.push({ drepId: row.drepId, base, reason: 'no_base' });
      continue;
    }
    const check = validateHandle(base, row.drepId);
    if (!check.ok) {
      out.skipped.push({ drepId: row.drepId, base, reason: check.reason });
      continue;
    }
    if (taken.has(base)) {
      out.skipped.push({ drepId: row.drepId, base, reason: 'taken' });
      continue;
    }
    taken.add(base);
    out.assigned.push({ drepId: row.drepId, handle: base });
  }
  return out;
}

export interface Baseline { bases: Record<string, string[]> }
export interface SeedOverrides { assign: Record<string, string>; skip: string[] }
export type SeedFlag =
  | {
      handle: string;
      kind: 'collision' | 'owner_changed' | 'not_in_baseline' | 'reserved' | 'missing_registered_at' | 'override';
      drepIds: string[];
    }
  | { handle: string; kind: 'skipped'; reason: SkipReason; drepIds: string[] };
export interface SeedPlan {
  assigned: { drepId: string; handle: string; source: 'seed' | 'manual' }[];
  decided: string[];
  flags: SeedFlag[];
}

/**
 * The launch seed. Candidates are registered, named DReps. A base that existed
 * in the baseline goes to its earliest baseline owner still present, so a DRep
 * renamed onto an existing name before launch cannot take it even with an older
 * registration. Overrides (handle to drepId, or skip) are applied last.
 */
export function planSeed(rows: HandleCandidate[], baseline: Baseline, overrides: SeedOverrides): SeedPlan {
  const flags: SeedFlag[] = [];
  const byBase = new Map<string, HandleCandidate[]>();
  for (const row of rows) {
    const base = row.name ? handleBase(row.name) : '';
    if (!base) continue;
    const group = byBase.get(base);
    if (group) group.push(row);
    else byBase.set(base, [row]);
  }

  // Pre-pick the winner per base, then let assignHandles apply the handle rules.
  const winners: HandleCandidate[] = [];
  for (const [base, group] of byBase) {
    const sorted = [...group].sort(byRegistration);
    const ids = sorted.map((r) => r.drepId);
    const owners = baseline.bases[base];
    let winner = sorted[0];
    if (owners) {
      const baselineWinner = sorted.find((r) => owners.includes(r.drepId));
      if (baselineWinner) winner = baselineWinner;
      else flags.push({ handle: base, kind: 'owner_changed', drepIds: ids });
    } else {
      flags.push({ handle: base, kind: 'not_in_baseline', drepIds: ids });
    }
    if (sorted.length > 1) flags.push({ handle: base, kind: 'collision', drepIds: [...ids].sort() });
    if (winner.registeredAt === null) flags.push({ handle: base, kind: 'missing_registered_at', drepIds: [winner.drepId] });
    winners.push(winner);
  }

  const auto = assignHandles(winners, new Set());
  // Every skipped winner shows up in the report. Reserved names get their own
  // kind because they are the ones Tommy may assign by hand.
  for (const s of auto.skipped) {
    if (s.reason === 'reserved') flags.push({ handle: s.base, kind: 'reserved', drepIds: [s.drepId] });
    else flags.push({ handle: s.base, kind: 'skipped', reason: s.reason, drepIds: [s.drepId] });
  }

  const skip = new Set(overrides.skip);
  const overridden = new Set(Object.keys(overrides.assign));
  const overrideOwners = new Set(Object.values(overrides.assign));
  const assigned: SeedPlan['assigned'] = auto.assigned
    .filter((a) => !skip.has(a.handle) && !overridden.has(a.handle) && !overrideOwners.has(a.drepId))
    .map((a) => ({ ...a, source: 'seed' as const }));
  for (const [handle, drepId] of Object.entries(overrides.assign)) {
    assigned.push({ drepId, handle, source: 'manual' });
    flags.push({ handle, kind: 'override', drepIds: [drepId] });
  }

  return { assigned, decided: rows.map((r) => r.drepId), flags };
}
