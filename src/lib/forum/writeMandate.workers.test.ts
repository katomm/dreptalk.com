/// <reference types="@cloudflare/workers-types" />
// Per-write mandate resolution against real D1: which grant, if any, a write
// by this user in this topic is stamped with.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from '../db/forum.js';
import { buildInsertGovernanceAction } from '../db/governance.js';
import { PROPOSAL_DRAFTS_CATEGORY_SLUG } from '../../../config/categories.js';
import { resolvePostMandate, resolveTopicMandate, mandateProposers, parseActAs } from './writeMandate.js';

const db = () => env.DB;
const NOW = 1_753_000_000_000;
const PROPOSER_A = 'stake_test1mandateproposera';
const PROPOSER_B = 'stake_test1mandateproposerb';

let seq = 0;
const actionIdFor = (n: number) => `${'cd'.repeat(31)}${String(n).padStart(2, '0')}#0`;

async function insertGrant(args: {
  id: string;
  coUserId: string;
  govActionId: string;
  proposerStakeAddr?: string;
  status?: 'active' | 'revoked';
  redeemedAt?: number;
}) {
  const status = args.status ?? 'active';
  await db()
    .prepare(
      `INSERT INTO proposer_grants
         (id, proposer_user_id, proposer_stake_addr, gov_action_id, co_user_id, co_stake_addr, invite_code_hash, status, created_at, expires_at, redeemed_at, revoked_at)
       VALUES (?1, 'proposer-user', ?2, ?3, ?4, ?5, ?1, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      args.id,
      args.proposerStakeAddr ?? PROPOSER_A,
      args.govActionId,
      args.coUserId,
      `stake_test1co${args.coUserId}`,
      status,
      NOW,
      NOW + 604800,
      args.redeemedAt ?? NOW,
      status === 'revoked' ? NOW : null,
    )
    .run();
}

/** A governance thread with its action row. */
async function governanceThread() {
  const s = seq++;
  const { topic } = await createTopic(db(), {
    categorySlug: 'governance-actions', authorId: 'gov-sync', title: `Gov ${s}`, bodyMd: 'x', bodyHtml: '<p>x</p>',
    source: 'governance', now: NOW, rand: `wm${s}`,
  });
  const actionId = actionIdFor(s);
  await buildInsertGovernanceAction(db(), {
    id: actionId, proposalId: null, type: 'InfoAction', title: 'Action', abstract: null, rationaleHtml: null,
    authors: null, references: null, anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor',
    returnAddress: PROPOSER_A, deposit: null, submittedEpoch: 1, submittedAt: null, expiryEpoch: null,
    enactedEpoch: null, onchainPayload: null, metaVersion: 1, topicId: topic.id, now: NOW,
  }).run();
  return { topic: { id: topic.id, category_slug: topic.category_slug }, actionId };
}

const draftTopic = { id: 'not-a-real-draft', category_slug: PROPOSAL_DRAFTS_CATEGORY_SLUG };

describe('parseActAs', () => {
  it('accepts self and a proposer address, nothing else', () => {
    expect(parseActAs('self')).toBe('self');
    expect(parseActAs({ proposerStakeAddr: PROPOSER_A })).toEqual({ proposerStakeAddr: PROPOSER_A });
    for (const bad of [undefined, null, '', 'SELF', 1, [], {}, { proposerStakeAddr: '' }, { proposerStakeAddr: 7 },
      { proposerStakeAddr: PROPOSER_A, extra: 1 }, [PROPOSER_A]]) {
      expect(parseActAs(bad)).toBeUndefined();
    }
  });
});

describe('resolvePostMandate: governance threads', () => {
  it('returns the grant for the thread of its own action', async () => {
    const { topic, actionId } = await governanceThread();
    await insertGrant({ id: 'wm-gov-own', coUserId: 'wm-u1', govActionId: actionId });
    expect(await resolvePostMandate(db(), 'wm-u1', topic)).toEqual({ grantId: 'wm-gov-own' });
    // actAs plays no part in a governance thread.
    expect(await resolvePostMandate(db(), 'wm-u1', topic, 'self')).toEqual({ grantId: 'wm-gov-own' });
  });

  it('returns null in the thread of another action of the same proposer', async () => {
    const a = await governanceThread();
    const b = await governanceThread();
    await insertGrant({ id: 'wm-gov-a', coUserId: 'wm-u2', govActionId: a.actionId });
    expect(await resolvePostMandate(db(), 'wm-u2', b.topic)).toEqual({ grantId: null });
  });

  it('returns null once the grant is revoked', async () => {
    const { topic, actionId } = await governanceThread();
    await insertGrant({ id: 'wm-gov-revoked', coUserId: 'wm-u3', govActionId: actionId, status: 'revoked' });
    expect(await resolvePostMandate(db(), 'wm-u3', topic)).toEqual({ grantId: null });
  });

  it('returns null in a general topic even with an active grant', async () => {
    const { actionId } = await governanceThread();
    await insertGrant({ id: 'wm-gov-general', coUserId: 'wm-u4', govActionId: actionId });
    expect(await resolvePostMandate(db(), 'wm-u4', { id: 'x', category_slug: 'general' })).toEqual({ grantId: null });
  });
});

describe('resolvePostMandate / resolveTopicMandate: Proposal Drafts', () => {
  it('self gives no mandate', async () => {
    await insertGrant({ id: 'wm-d-self', coUserId: 'wm-d1', govActionId: actionIdFor(90) });
    expect(await resolvePostMandate(db(), 'wm-d1', draftTopic, 'self')).toEqual({ grantId: null });
    expect(await resolveTopicMandate(db(), 'wm-d1', PROPOSAL_DRAFTS_CATEGORY_SLUG, 'self')).toEqual({ grantId: null });
  });

  it('a proposer choice gives the oldest active grant of that proposer', async () => {
    await insertGrant({ id: 'wm-d-a-new', coUserId: 'wm-d2', govActionId: actionIdFor(91), redeemedAt: NOW + 10 });
    await insertGrant({ id: 'wm-d-a-old', coUserId: 'wm-d2', govActionId: actionIdFor(92), redeemedAt: NOW });
    await insertGrant({ id: 'wm-d-b', coUserId: 'wm-d2', govActionId: actionIdFor(93), proposerStakeAddr: PROPOSER_B });
    const actA = { proposerStakeAddr: PROPOSER_A };
    const actB = { proposerStakeAddr: PROPOSER_B };
    expect(await resolvePostMandate(db(), 'wm-d2', draftTopic, actA)).toEqual({ grantId: 'wm-d-a-old' });
    expect(await resolveTopicMandate(db(), 'wm-d2', PROPOSAL_DRAFTS_CATEGORY_SLUG, actB)).toEqual({ grantId: 'wm-d-b' });
  });

  it('a proposer the user holds no grant from borrows nothing', async () => {
    await insertGrant({ id: 'wm-d-forged', coUserId: 'wm-d3', govActionId: actionIdFor(94) });
    // Someone else's grant from PROPOSER_B exists, but not for this user.
    await insertGrant({ id: 'wm-d-other', coUserId: 'wm-d3-other', govActionId: actionIdFor(95), proposerStakeAddr: PROPOSER_B });
    expect(await resolvePostMandate(db(), 'wm-d3', draftTopic, { proposerStakeAddr: PROPOSER_B })).toEqual({ grantId: null });
  });

  it('a revoked grant gives no mandate', async () => {
    await insertGrant({ id: 'wm-d-revoked', coUserId: 'wm-d4', govActionId: actionIdFor(96), status: 'revoked' });
    expect(await resolvePostMandate(db(), 'wm-d4', draftTopic, { proposerStakeAddr: PROPOSER_A })).toEqual({ grantId: null });
    expect(await resolvePostMandate(db(), 'wm-d4', draftTopic)).toEqual({ grantId: null });
  });

  it('without a choice: one proposer is used, several ask for a choice, none gives null', async () => {
    await insertGrant({ id: 'wm-d-one-1', coUserId: 'wm-d5', govActionId: actionIdFor(97), redeemedAt: NOW });
    await insertGrant({ id: 'wm-d-one-2', coUserId: 'wm-d5', govActionId: actionIdFor(98), redeemedAt: NOW + 5 });
    expect(await resolveTopicMandate(db(), 'wm-d5', PROPOSAL_DRAFTS_CATEGORY_SLUG)).toEqual({ grantId: 'wm-d-one-1' });

    await insertGrant({ id: 'wm-d-two-a', coUserId: 'wm-d6', govActionId: actionIdFor(80) });
    await insertGrant({ id: 'wm-d-two-b', coUserId: 'wm-d6', govActionId: actionIdFor(81), proposerStakeAddr: PROPOSER_B });
    expect(await resolvePostMandate(db(), 'wm-d6', draftTopic)).toEqual({ error: 'choose_proposer' });

    expect(await resolvePostMandate(db(), 'wm-d7-nobody', draftTopic)).toEqual({ grantId: null });
  });

  it('resolveTopicMandate gives no mandate outside Proposal Drafts', async () => {
    await insertGrant({ id: 'wm-t-general', coUserId: 'wm-t1', govActionId: actionIdFor(82) });
    expect(await resolveTopicMandate(db(), 'wm-t1', 'general')).toEqual({ grantId: null });
  });
});

describe('mandateProposers', () => {
  it('lists each proposer of the active grants once', async () => {
    await insertGrant({ id: 'wm-p-1', coUserId: 'wm-p', govActionId: actionIdFor(83) });
    await insertGrant({ id: 'wm-p-2', coUserId: 'wm-p', govActionId: actionIdFor(84) });
    await insertGrant({ id: 'wm-p-3', coUserId: 'wm-p', govActionId: actionIdFor(85), proposerStakeAddr: PROPOSER_B });
    await insertGrant({ id: 'wm-p-4', coUserId: 'wm-p', govActionId: actionIdFor(86), proposerStakeAddr: 'stake_test1gone', status: 'revoked' });
    const list = await mandateProposers(db(), 'wm-p');
    expect(list.map((p) => p.proposerStakeAddr)).toEqual([PROPOSER_A, PROPOSER_B]);
    for (const p of list) expect(p.label.length).toBeGreaterThan(0);
  });
});
