import { describe, it, expect } from 'vitest';
import {
  MATCH_THRESHOLDS,
  buildMatchDreps,
  decodeShareFragment,
  discriminativeScore,
  encodeShareFragment,
  minAnsweredFor,
  minSharedFor,
  rankDreps,
  selectQuestions,
  setFingerprint,
  type CandidateAgg,
  type MatchDrep,
  type MatrixVoteRow,
  type UserAnswer,
} from './logic.js';

function cand(over: Partial<CandidateAgg>): CandidateAgg {
  return { gaId: 'a'.repeat(64) + '#0', type: 'InfoAction', expiryEpoch: 600, yes: 50, no: 50, abstain: 0, ...over };
}

describe('derived thresholds', () => {
  it('computes two-thirds participation and the shared floor', () => {
    expect(minAnsweredFor(15)).toBe(10);
    expect(minSharedFor(15)).toBe(8);
    expect(minAnsweredFor(8)).toBe(6);
    expect(minSharedFor(8)).toBe(4);
    expect(minSharedFor(3)).toBe(2); // never below 2
  });
});

describe('discriminativeScore', () => {
  it('is 1 on a perfect split and 0 when unanimous', () => {
    expect(discriminativeScore({ yes: 40, no: 40 })).toBe(1);
    expect(discriminativeScore({ yes: 80, no: 0 })).toBe(0);
    expect(discriminativeScore({ yes: 0, no: 0 })).toBe(0);
  });
});

describe('selectQuestions', () => {
  const t = { ...MATCH_THRESHOLDS.mainnet, maxQuestions: 3, maxPerType: 2, minDecisiveVotes: 10 };

  it('filters below the decisive-vote floor', () => {
    const out = selectQuestions([cand({ yes: 4, no: 4 })], t);
    expect(out).toHaveLength(0);
  });

  it('filters abstain-heavy actions even with a perfect split', () => {
    // 25 yes, 25 no, 400 abstain: score 1.0 but 89 percent abstained
    const out = selectQuestions([cand({ yes: 25, no: 25, abstain: 400 })], t);
    expect(out).toHaveLength(0);
  });

  it('caps per action type', () => {
    const cands = [
      cand({ gaId: 'a'.repeat(64) + '#0', type: 'TreasuryWithdrawals', yes: 50, no: 50 }),
      cand({ gaId: 'b'.repeat(64) + '#0', type: 'TreasuryWithdrawals', yes: 49, no: 51 }),
      cand({ gaId: 'c'.repeat(64) + '#0', type: 'TreasuryWithdrawals', yes: 48, no: 52 }),
      cand({ gaId: 'd'.repeat(64) + '#0', type: 'InfoAction', yes: 30, no: 70 }),
    ];
    const out = selectQuestions(cands, t);
    expect(out.map((c) => c.type).filter((x) => x === 'TreasuryWithdrawals')).toHaveLength(2);
    expect(out).toHaveLength(3);
  });

  it('orders by score, then newer expiry, then gaId, deterministically', () => {
    const cands = [
      cand({ gaId: 'b'.repeat(64) + '#0', type: 'TreasuryWithdrawals', yes: 50, no: 50, expiryEpoch: 500 }),
      cand({ gaId: 'a'.repeat(64) + '#0', type: 'ParameterChange', yes: 50, no: 50, expiryEpoch: 500 }),
      cand({ gaId: 'c'.repeat(64) + '#0', type: 'HardForkInitiation', yes: 50, no: 50, expiryEpoch: 600 }),
      cand({ gaId: 'd'.repeat(64) + '#0', type: 'InfoAction', yes: 20, no: 80, expiryEpoch: 700 }),
    ];
    const out = selectQuestions(cands, { ...t, maxQuestions: 4 });
    expect(out.map((c) => c.gaId[0])).toEqual(['c', 'a', 'b', 'd']);
    // Same input in any order gives the same output
    const shuffled = [cands[3], cands[0], cands[2], cands[1]];
    expect(selectQuestions(shuffled, { ...t, maxQuestions: 4 })).toEqual(out);
  });
});

function matrixRow(over: Partial<MatrixVoteRow>): MatrixVoteRow {
  return {
    drep_id: 'drep1x', slug: null, name: 'Some DRep', image_content_hash: null, hex: null,
    has_script: 0, voting_power: '1000000', delegator_count: 3, ga_id: 'ga1', vote: 'Yes',
    has_rationale: 0,
    ...over,
  };
}

describe('buildMatchDreps', () => {
  it('builds aligned vote and rationale strings and drops low participation', () => {
    const gaIds = ['ga1', 'ga2', 'ga3'];
    const rows = [
      matrixRow({ drep_id: 'drep1a', ga_id: 'ga1', vote: 'Yes', has_rationale: 1 }),
      matrixRow({ drep_id: 'drep1a', ga_id: 'ga3', vote: 'Abstain' }),
      matrixRow({ drep_id: 'drep1b', ga_id: 'ga2', vote: 'No' }),
    ];
    const out = buildMatchDreps(rows, gaIds, 2);
    expect(out).toHaveLength(1);
    expect(out[0].drepId).toBe('drep1a');
    expect(out[0].votes).toBe('Y-A');
    expect(out[0].rationales).toBe('100');
  });

  it('maps a lowercase optimistic vote the same as its capitalized form', () => {
    // recordLocalVote writes lowercase 'yes'/'no'/'abstain' for a pending
    // optimistic vote, see voteStatement.ts and drepVotes.ts.
    const gaIds = ['ga1'];
    const rows = [matrixRow({ drep_id: 'drep1a', ga_id: 'ga1', vote: 'yes' })];
    const out = buildMatchDreps(rows, gaIds, 1);
    expect(out).toHaveLength(1);
    expect(out[0].votes).toBe('Y');
  });
});

function md(over: Partial<MatchDrep>): MatchDrep {
  return {
    drepId: 'drep1x', slug: null, name: 'X', imageHash: null, identiconSeed: 'drep1x',
    credentialHex: null, isScript: false,
    powerLovelace: '1000000', delegatorCount: 0, votes: 'YYY', rationales: '000',
    ...over,
  };
}

describe('rankDreps', () => {
  it('scores exact 1, abstain-vs-firm 0.5, opposite 0 over shared questions', () => {
    const answers: UserAnswer[] = ['y', 'n', 'a', 's'];
    const drep = md({ votes: 'YYAN', rationales: '0000' });
    // y-Y = 1, n-Y = 0, a-A = 1, s skipped. 2 of 3 shared = 67 percent
    const out = rankDreps(answers, [drep], 2);
    expect(out[0].shared).toBe(3);
    expect(out[0].points).toBe(2);
    expect(out[0].matchPct).toBe(67);
  });

  it('reports the points behind the percent, halves included', () => {
    const answers: UserAnswer[] = ['y', 'y', 'y', 'y'];
    // Two exact, one abstain against a firm yes, one opposite: 2.5 of 4.
    const out = rankDreps(answers, [md({ votes: 'YYAN', rationales: '0000' })], 2);
    expect(out[0].points).toBe(2.5);
    expect(out[0].shared).toBe(4);
    expect(out[0].matchPct).toBe(63);
  });

  it('sends different shared counts to the same percent, which is why points ship with it', () => {
    const answers: UserAnswer[] = ['y', 'y', 'y', 'y', 'y', 'y', 'y', 'y', 'y', 'y'];
    // 7.5 of 10 and 6 of 8 are both 75 percent.
    const ten = md({ drepId: 'drep1ten', votes: 'YYYYYYYANN', rationales: '0'.repeat(10) });
    const eight = md({ drepId: 'drep1eight', votes: 'YYYYYYNN--', rationales: '0'.repeat(10) });
    const out = rankDreps(answers, [ten, eight], 2);
    expect(out.map((r) => r.matchPct)).toEqual([75, 75]);
    expect(out.map((r) => [r.points, r.shared])).toEqual([
      [7.5, 10],
      [6, 8],
    ]);
  });

  it('gives half points for abstain against a firm position, both directions', () => {
    const answers: UserAnswer[] = ['y', 'a'];
    const drep = md({ votes: 'AY', rationales: '00' });
    const out = rankDreps(answers, [drep], 2);
    expect(out[0].matchPct).toBe(50);
  });

  it('drops DReps below the shared floor even at 100 percent', () => {
    const answers: UserAnswer[] = ['y', 's', 's', 's'];
    const perfect = md({ drepId: 'drep1small', votes: 'Y---', rationales: '0000' });
    expect(rankDreps(answers, [perfect], 2)).toHaveLength(0);
  });

  it('breaks ties: pct, then shared, then smaller power, then drepId', () => {
    const answers: UserAnswer[] = ['y', 'y', 'y'];
    const a = md({ drepId: 'drep1b', votes: 'YYY', powerLovelace: '2000000' });
    const b = md({ drepId: 'drep1a', votes: 'YYY', powerLovelace: '2000000' });
    const c = md({ drepId: 'drep1c', votes: 'YYY', powerLovelace: '1000000' });
    const d = md({ drepId: 'drep1d', votes: 'YY-', powerLovelace: '1' });
    const out = rankDreps(answers, [a, b, c, d], 2);
    expect(out.map((r) => r.drep.drepId)).toEqual(['drep1c', 'drep1a', 'drep1b', 'drep1d']);
  });
});

describe('share fragment', () => {
  it('round-trips fingerprint and answers', async () => {
    const fp = await setFingerprint(['ga1', 'ga2']);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    const frag = encodeShareFragment(fp, ['y', 'n', 'a', 's']);
    expect(frag).toBe(`r=v1.${fp}.ynas`);
    expect(decodeShareFragment(`#${frag}`)).toEqual({ fingerprint: fp, answers: ['y', 'n', 'a', 's'] });
  });

  it('changes the fingerprint when the set or its order changes', async () => {
    expect(await setFingerprint(['ga1', 'ga2'])).not.toBe(await setFingerprint(['ga2', 'ga1']));
  });

  it('rejects malformed fragments', () => {
    expect(decodeShareFragment('')).toBeNull();
    expect(decodeShareFragment('#r=v2.abcd1234.yn')).toBeNull();
    expect(decodeShareFragment('#r=v1.abcd1234.yx')).toBeNull();
    expect(decodeShareFragment('#other=1')).toBeNull();
  });
});
