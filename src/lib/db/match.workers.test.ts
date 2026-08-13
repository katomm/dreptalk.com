import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { loadMatchCandidates, loadMatchMatrix } from './match.js';

const DB = () => env.DB as D1Database;
const GA = (n: number) => `${String(n).padStart(2, '0').repeat(32)}#0`;

async function seedAction(id: string, over: Partial<{ type: string; status: string; title: string; expiry: number }> = {}) {
  await DB()
    .prepare(
      `INSERT INTO governance_actions (id, type, title, status, expiry_epoch, created_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
    )
    .bind(id, over.type ?? 'InfoAction', over.title ?? 'Title', over.status ?? 'enacted', over.expiry ?? 500)
    .run();
}

async function seedDrep(drepId: string, over: Partial<{ active: number; name: string | null; doNotList: number; power: string }> = {}) {
  await DB()
    .prepare(
      `INSERT INTO dreps (drep_id, status, active, name, do_not_list, voting_power, last_synced_at, created_at)
       VALUES (?, 'registered', ?, ?, ?, ?, 0, 0)`,
    )
    .bind(drepId, over.active ?? 1, over.name === undefined ? 'Named DRep' : over.name, over.doNotList ?? 0, over.power ?? '1000000000000')
    .run();
}

async function seedVote(gaId: string, drepId: string, vote: string, localStatus: string | null = null) {
  await DB()
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, local_status)
       VALUES (?, 'DRep', ?, ?, 0, ?)`,
    )
    .bind(gaId, drepId, vote, localStatus)
    .run();
}

async function seedRationale(gaId: string, drepId: string, status = 'ok', bodyText = 'Because reasons.') {
  await DB()
    .prepare(
      `INSERT INTO action_rationale (ga_id, voter_id, body_html, body_text, source, status, attempts, created_at, fetched_at)
       VALUES (?, ?, '<p>x</p>', ?, 'onchain', ?, 0, 0, 0)`,
    )
    .bind(gaId, drepId, bodyText, status)
    .run();
}

beforeEach(async () => {
  await DB().prepare('DELETE FROM drep_votes').run();
  await DB().prepare('DELETE FROM governance_actions').run();
  await DB().prepare('DELETE FROM dreps').run();
  await DB().prepare('DELETE FROM action_rationale').run();
});

describe('loadMatchCandidates', () => {
  it('aggregates head counts for terminal actions only, newest first', async () => {
    await seedAction(GA(1), { status: 'enacted', expiry: 500 });
    await seedAction(GA(2), { status: 'active', expiry: 600 });
    await seedAction(GA(3), { status: 'expired', expiry: 700 });
    await seedDrep('drep1a');
    await seedDrep('drep1b');
    await seedVote(GA(1), 'drep1a', 'Yes');
    await seedVote(GA(1), 'drep1b', 'No');
    await seedVote(GA(2), 'drep1a', 'Yes');
    await seedVote(GA(3), 'drep1a', 'Abstain');

    const rows = await loadMatchCandidates(DB(), 100);
    expect(rows.map((r) => r.ga_id)).toEqual([GA(3), GA(1)]);
    expect(rows[1]).toMatchObject({ yes: 1, no: 1, abstain: 0 });
    expect(rows[0]).toMatchObject({ yes: 0, no: 0, abstain: 1 });
  });

  it('ignores failed optimistic votes and respects the pool window', async () => {
    await seedAction(GA(1), { expiry: 500 });
    await seedAction(GA(2), { expiry: 600 });
    await seedDrep('drep1a');
    await seedVote(GA(1), 'drep1a', 'Yes', 'failed');
    await seedVote(GA(2), 'drep1a', 'Yes');

    const rows = await loadMatchCandidates(DB(), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].ga_id).toBe(GA(2));
  });

  it('counts a pending optimistic vote stored lowercase and surfaces it in the matrix', async () => {
    // recordLocalVote writes lowercase 'yes'/'no'/'abstain' with local_status
    // 'pending' until the authoritative sync overwrites it, see drepVotes.ts.
    await seedAction(GA(1), { expiry: 500 });
    await seedDrep('drep1a');
    await seedDrep('drep1b');
    await seedVote(GA(1), 'drep1a', 'yes', 'pending');
    await seedVote(GA(1), 'drep1b', 'No');

    const candidateRows = await loadMatchCandidates(DB(), 100);
    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]).toMatchObject({ yes: 1, no: 1, abstain: 0 });

    const matrixRows = await loadMatchMatrix(DB(), [GA(1)], 50_000_000_000_000);
    expect(matrixRows.map((r) => r.drep_id).sort()).toEqual(['drep1a', 'drep1b']);
    expect(matrixRows.find((r) => r.drep_id === 'drep1a')).toMatchObject({ vote: 'yes' });
  });
});

describe('loadMatchMatrix', () => {
  it('returns only eligible DReps with their votes and rationale flags', async () => {
    await seedAction(GA(1));
    await seedDrep('drep1ok');
    await seedDrep('drep1big', { power: '50000000000001' });
    await seedDrep('drep1anon', { name: null });
    await seedDrep('drep1hidden', { doNotList: 1 });
    await seedDrep('drep1inactive', { active: 0 });
    for (const id of ['drep1ok', 'drep1big', 'drep1anon', 'drep1hidden', 'drep1inactive']) {
      await seedVote(GA(1), id, 'Yes');
    }
    await seedRationale(GA(1), 'drep1ok');

    const rows = await loadMatchMatrix(DB(), [GA(1)], 50_000_000_000_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ drep_id: 'drep1ok', vote: 'Yes', has_rationale: 1 });
  });

  it('keeps DReps exactly at the power cap and flags empty rationales as absent', async () => {
    await seedAction(GA(1));
    await seedDrep('drep1edge', { power: '50000000000000' });
    await seedVote(GA(1), 'drep1edge', 'No');
    await seedRationale(GA(1), 'drep1edge', 'empty', '');

    const rows = await loadMatchMatrix(DB(), [GA(1)], 50_000_000_000_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].has_rationale).toBe(0);
  });

  it('excludes the special pseudo-DReps', async () => {
    await seedAction(GA(1));
    await seedDrep('drep_always_abstain');
    await seedVote(GA(1), 'drep_always_abstain', 'Abstain');
    expect(await loadMatchMatrix(DB(), [GA(1)], 50_000_000_000_000)).toHaveLength(0);
  });

  it('uses only the latest vote when a re-vote is archived in history', async () => {
    // Guards the spec's final-votes-only rule against ingestion changes:
    // the matrix must read drep_votes (one live row per DRep and action),
    // never drep_vote_history.
    await seedAction(GA(1));
    await seedDrep('drep1revoter');
    await seedVote(GA(1), 'drep1revoter', 'Yes');
    await DB()
      .prepare(
        `INSERT INTO drep_vote_history (ga_id, voter_id, voter_role, vote, block_time, superseded_at)
         VALUES (?, 'drep1revoter', 'DRep', 'No', 1, 2)`,
      )
      .bind(GA(1))
      .run();

    const rows = await loadMatchMatrix(DB(), [GA(1)], 50_000_000_000_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].vote).toBe('Yes');
  });
});
