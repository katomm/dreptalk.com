// Pure logic for the DRep matching quiz on /match: question selection,
// matrix grouping, scoring, ranking, and share-fragment encoding. Shared by
// the SSR page and the MatchQuiz island. No D1 access in this module.

import type { CardanoNetwork } from '@/lib/config/network.js';

export type UserAnswer = 'y' | 'n' | 'a' | 's';

export interface MatchThresholds {
  /** Candidate pool: the N most recently completed actions with DRep votes. */
  poolWindow: number;
  /** Maximum question set size. The actual set is however many qualify. */
  maxQuestions: number;
  /** Below this many selected questions the page shows the no-data state. */
  minQuestions: number;
  /** Minimum Yes plus No head count for an action to qualify as a question. */
  minDecisiveVotes: number;
  /** Actions at or above this Abstain share are not discriminative. */
  maxAbstainShare: number;
  /** Per-type cap so one action type cannot dominate the set. */
  maxPerType: number;
  /** Ranking only shows DReps at or below this voting power (lovelace). */
  powerCapLovelace: number;
}

export const MATCH_THRESHOLDS: Record<CardanoNetwork, MatchThresholds> = {
  mainnet: {
    poolWindow: 100,
    maxQuestions: 10,
    minQuestions: 5,
    minDecisiveVotes: 50,
    maxAbstainShare: 0.6,
    maxPerType: 4,
    powerCapLovelace: 50_000_000_000_000,
  },
  preprod: {
    poolWindow: 100,
    maxQuestions: 6,
    minQuestions: 4,
    minDecisiveVotes: 3,
    maxAbstainShare: 0.6,
    maxPerType: 4,
    powerCapLovelace: 50_000_000_000_000,
  },
};

/** DReps and users must cover two thirds of the set for scores to mean much. */
export function minAnsweredFor(setSize: number): number {
  return Math.ceil((2 * setSize) / 3);
}

/** Ranking gate on shared questions between one DRep and the user. */
export function minSharedFor(setSize: number): number {
  return Math.max(2, minAnsweredFor(setSize) - 2);
}

export interface CandidateAgg {
  gaId: string;
  type: string;
  expiryEpoch: number | null;
  yes: number;
  no: number;
  abstain: number;
}

/** 1 = perfectly split Yes/No field, 0 = unanimous. Head counts, not power. */
export function discriminativeScore(c: Pick<CandidateAgg, 'yes' | 'no'>): number {
  const decisive = c.yes + c.no;
  if (decisive === 0) return 0;
  return 1 - Math.abs(c.yes - c.no) / decisive;
}

/**
 * The deterministic question set. The share fingerprint hashes the resulting
 * order, so every sort key must be stable across requests with equal data.
 */
export function selectQuestions<T extends CandidateAgg>(candidates: readonly T[], t: MatchThresholds): T[] {
  const qualified = candidates.filter((c) => {
    const decisive = c.yes + c.no;
    const total = decisive + c.abstain;
    return decisive >= t.minDecisiveVotes && total > 0 && c.abstain / total < t.maxAbstainShare;
  });
  const sorted = [...qualified].sort(
    (a, b) =>
      discriminativeScore(b) - discriminativeScore(a) ||
      (b.expiryEpoch ?? -1) - (a.expiryEpoch ?? -1) ||
      (a.gaId < b.gaId ? -1 : a.gaId > b.gaId ? 1 : 0),
  );
  const perType = new Map<string, number>();
  const picked: T[] = [];
  for (const c of sorted) {
    const seen = perType.get(c.type) ?? 0;
    if (seen >= t.maxPerType) continue;
    perType.set(c.type, seen + 1);
    picked.push(c);
    if (picked.length >= t.maxQuestions) break;
  }
  return picked;
}

export interface MatchDrep {
  drepId: string;
  slug: string | null;
  name: string;
  imageHash: string | null;
  identiconSeed: string;
  /** Delegation credential for the DelegateButton target, hex from the row. */
  credentialHex: string | null;
  isScript: boolean;
  powerLovelace: string;
  delegatorCount: number | null;
  /** One char per question, aligned with the question order: Y, N, A or -. */
  votes: string;
  /** One char per question: 1 = a readable rationale exists for that vote. */
  rationales: string;
}

/** Raw row shape returned by loadMatchMatrix in src/lib/db/match.ts. */
export interface MatrixVoteRow {
  drep_id: string;
  slug: string | null;
  name: string;
  image_content_hash: string | null;
  hex: string | null;
  has_script: number;
  voting_power: string;
  delegator_count: number | null;
  ga_id: string;
  vote: string;
  has_rationale: number;
}

export function buildMatchDreps(
  rows: readonly MatrixVoteRow[],
  gaIds: readonly string[],
  minAnswered: number,
): MatchDrep[] {
  const index = new Map(gaIds.map((id, i) => [id, i]));
  const byDrep = new Map<string, { row: MatrixVoteRow; votes: string[]; rationales: string[] }>();
  for (const row of rows) {
    const qi = index.get(row.ga_id);
    if (qi === undefined) continue;
    let entry = byDrep.get(row.drep_id);
    if (!entry) {
      entry = {
        row,
        votes: new Array<string>(gaIds.length).fill('-'),
        rationales: new Array<string>(gaIds.length).fill('0'),
      };
      byDrep.set(row.drep_id, entry);
    }
    // Case-insensitive: synced votes are stored capitalized ("Yes"), but an
    // optimistic just-cast vote is stored lowercase ("yes"), see voteStatement.ts.
    const voteLower = row.vote.toLowerCase();
    const c = voteLower === 'yes' ? 'Y' : voteLower === 'no' ? 'N' : voteLower === 'abstain' ? 'A' : '-';
    entry.votes[qi] = c;
    if (row.has_rationale) entry.rationales[qi] = '1';
  }
  const out: MatchDrep[] = [];
  for (const { row, votes, rationales } of byDrep.values()) {
    const answered = votes.filter((v) => v !== '-').length;
    if (answered < minAnswered) continue;
    out.push({
      drepId: row.drep_id,
      slug: row.slug,
      name: row.name,
      imageHash: row.image_content_hash,
      identiconSeed: row.hex ?? row.drep_id,
      credentialHex: row.hex,
      isScript: row.has_script === 1,
      powerLovelace: row.voting_power,
      delegatorCount: row.delegator_count,
      votes: votes.join(''),
      rationales: rationales.join(''),
    });
  }
  return out;
}

export interface RankedDrep {
  drep: MatchDrep;
  /** Whole percent, also the primary sort key so ranking matches display. */
  matchPct: number;
  shared: number;
}

// Identical vote 1, abstain against a firm position 0.5, yes against no 0.
const POINTS: Record<string, number> = {
  yY: 1,
  nN: 1,
  aA: 1,
  yA: 0.5,
  nA: 0.5,
  aY: 0.5,
  aN: 0.5,
};

export function rankDreps(
  answers: readonly UserAnswer[],
  dreps: readonly MatchDrep[],
  minShared: number,
): RankedDrep[] {
  const ranked: RankedDrep[] = [];
  for (const d of dreps) {
    let points = 0;
    let shared = 0;
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i];
      const v = d.votes[i];
      if (a === 's' || a === undefined || v === '-' || v === undefined) continue;
      shared++;
      points += POINTS[`${a}${v}`] ?? 0;
    }
    if (shared < minShared) continue;
    ranked.push({ drep: d, matchPct: Math.round((points / shared) * 100), shared });
  }
  ranked.sort(
    (x, y) =>
      y.matchPct - x.matchPct ||
      y.shared - x.shared ||
      comparePower(x.drep.powerLovelace, y.drep.powerLovelace) ||
      (x.drep.drepId < y.drep.drepId ? -1 : 1),
  );
  return ranked;
}

/** Smaller power ranks first. Lovelace strings can exceed Number precision. */
function comparePower(a: string, b: string): number {
  let x: bigint;
  let y: bigint;
  try {
    x = BigInt(a);
    y = BigInt(b);
  } catch {
    return 0;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

const FRAGMENT_RE = /^v1\.([0-9a-f]{8})\.([ynas]+)$/;

/**
 * First 8 hex chars of SHA-256 over the ordered, newline-joined ga_id list.
 * Guards share links against silently mismatched question sets.
 */
export async function setFingerprint(gaIds: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(gaIds.join('\n'));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

export function encodeShareFragment(fingerprint: string, answers: readonly UserAnswer[]): string {
  return `r=v1.${fingerprint}.${answers.join('')}`;
}

export function decodeShareFragment(hash: string): { fingerprint: string; answers: UserAnswer[] } | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith('r=')) return null;
  const m = FRAGMENT_RE.exec(raw.slice(2));
  if (!m) return null;
  return { fingerprint: m[1], answers: [...m[2]] as UserAnswer[] };
}
