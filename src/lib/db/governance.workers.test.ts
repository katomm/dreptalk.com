/// <reference types="@cloudflare/workers-types" />
// Governance-action data access tests, run in real workerd via vitest-pool-workers.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  buildInsertGovernanceAction,
  getGovernanceActionByTopicId,
  getActiveGovernanceActions,
  getGovernanceActionsByTopicIds,
  updateGovernanceTallyAndStatus,
  type NewGovernanceAction,
} from './governance.js';

const db = () => env.DB;
const NOW = 1_753_000_000_000;

let seq = 0;
async function insertAction(over: Partial<NewGovernanceAction> = {}): Promise<NewGovernanceAction> {
  seq++;
  const a: NewGovernanceAction = {
    id: `tx${seq}#0`,
    proposalId: `gov_action_seq_${seq}`,
    type: 'TreasuryWithdrawals',
    title: `Action ${seq}`,
    abstract: 'abstract',
    rationaleHtml: '<p>why</p>',
    anchorUrl: 'https://example.com/a.json',
    anchorHash: 'hash',
    anchorStatus: 'ok',
    returnAddress: `stake_test_${seq}`,
    deposit: '100000000000',
    submittedEpoch: 287,
    expiryEpoch: 294,
    topicId: `topic-${seq}`,
    now: NOW,
    ...over,
  };
  await db().batch([buildInsertGovernanceAction(db(), a)]);
  return a;
}

describe('getGovernanceActionByTopicId', () => {
  it('reads back an inserted action incl. proposal_id', async () => {
    const a = await insertAction();
    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(a.id);
    expect(got!.proposalId).toBe(a.proposalId);
    expect(got!.status).toBe('active');
    expect(got!.expiryEpoch).toBe(294);
    expect(got!.drepYesPct).toBeNull();
  });

  it('returns null for an unknown topic', async () => {
    expect(await getGovernanceActionByTopicId(db(), 'nope')).toBeNull();
  });
});

describe('getActiveGovernanceActions', () => {
  it('includes active actions and excludes frozen ones', async () => {
    const active = await insertAction();
    const frozen = await insertAction();
    await updateGovernanceTallyAndStatus(db(), {
      id: frozen.id,
      status: 'expired',
      drepYes: null, drepNo: null, drepAbstain: null,
      spoYes: null, spoNo: null, spoAbstain: null,
      ccYes: null, ccNo: null, ccAbstain: null,
      drepYesPct: null, drepNoPct: null, spoYesPct: null, spoNoPct: null,
      ccYesPct: null, ccNoPct: null,
      tallyEpoch: 295, tallySyncedAt: NOW, now: NOW,
    });

    const rows = await getActiveGovernanceActions(db());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(frozen.id);
  });
});

describe('updateGovernanceTallyAndStatus', () => {
  it('writes pct, counts, tally epoch and synced-at', async () => {
    const a = await insertAction();
    await updateGovernanceTallyAndStatus(db(), {
      id: a.id,
      status: 'active',
      drepYes: 1, drepNo: 1, drepAbstain: 1,
      spoYes: 0, spoNo: 0, spoAbstain: 0,
      ccYes: 0, ccNo: 0, ccAbstain: 0,
      drepYesPct: 0.01, drepNoPct: 99.99, spoYesPct: 0, spoNoPct: 0,
      ccYesPct: 0, ccNoPct: 100,
      tallyEpoch: 293, tallySyncedAt: NOW + 5, now: NOW + 5,
    });

    const got = await getGovernanceActionByTopicId(db(), a.topicId);
    expect(got!.drepNoPct).toBeCloseTo(99.99);
    expect(got!.drepYes).toBe(1);
    expect(got!.tallyEpoch).toBe(293);
    expect(got!.tallySyncedAt).toBe(NOW + 5);
  });
});

describe('getGovernanceActionsByTopicIds', () => {
  it('batch-returns only matching topic ids', async () => {
    const a = await insertAction();
    const b = await insertAction();
    const map = await getGovernanceActionsByTopicIds(db(), [a.topicId, b.topicId, 'missing']);
    expect(map.size).toBe(2);
    expect(map.get(a.topicId)!.id).toBe(a.id);
    expect(map.get(b.topicId)!.id).toBe(b.id);
  });

  it('returns an empty map for empty input', async () => {
    const map = await getGovernanceActionsByTopicIds(db(), []);
    expect(map.size).toBe(0);
  });
});
