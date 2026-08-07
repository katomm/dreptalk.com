/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { searchRationalesPage, countScopes, PAGE_SIZE } from './search.js';
import { upsertActionRationale } from './actionRationale.js';
import { upsertDrep } from './dreps.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

async function seedTopic(o: { id: string; slug: string; title: string }) {
  await db()
    .prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
       VALUES (?, 'governance-actions', 'system', 'governance', ?, ?, 0, ?, ?, 0)`,
    )
    .bind(o.id, o.title, o.slug, NOW, NOW)
    .run();
}

async function seedGa(o: { id: string; title: string; topicId: string }) {
  await db()
    .prepare(
      `INSERT INTO governance_actions (id, proposal_id, type, title, abstract, status, topic_id, created_at, last_synced_at)
       VALUES (?, ?, 'InfoAction', ?, NULL, 'enacted', ?, ?, ?)`,
    )
    .bind(o.id, `prop_${o.id}`, o.title, o.topicId, NOW, NOW)
    .run();
}

async function seedVote(o: { gaId: string; voterId: string; vote: string }) {
  await db()
    .prepare(
      `INSERT INTO drep_votes (ga_id, voter_role, voter_id, voter_hex, vote, synced_at, block_time)
       VALUES (?, 'DRep', ?, NULL, ?, ?, ?)`,
    )
    .bind(o.gaId, o.voterId, o.vote, NOW, 1_700_000_000)
    .run();
}

function drepArgs(overrides: Partial<Parameters<typeof upsertDrep>[1]>): Parameters<typeof upsertDrep>[1] {
  return {
    drepId: 'drep1fixture', hex: null, hasScript: false, status: 'registered', active: true,
    deposit: null, votingPower: '5000000000', expiresEpochNo: null, name: null, bio: null,
    imageUrl: null, imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null,
    links: null, motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'pending', profileExtractVersion: 0, lastSyncedAt: NOW, createdAt: NOW,
    ...overrides,
  };
}

async function seedRationale(o: { gaId: string; slug: string; title: string; voterId: string; drepName: string; vote: string; bodyHtml: string; status?: 'ok' | 'empty' | 'failed' }) {
  await seedTopic({ id: `t-${o.gaId}`, slug: o.slug, title: o.title });
  await seedGa({ id: o.gaId, title: o.title, topicId: `t-${o.gaId}` });
  await upsertDrep(db(), drepArgs({ drepId: o.voterId, name: o.drepName }));
  await seedVote({ gaId: o.gaId, voterId: o.voterId, vote: o.vote });
  await upsertActionRationale(db(), {
    gaId: o.gaId, voterId: o.voterId, bodyHtml: o.bodyHtml, source: 'onchain',
    anchorUrl: 'https://x', status: o.status ?? 'ok', createdAt: NOW, now: NOW,
  });
}

describe('searchRationalesPage', () => {
  it('returns a rationale hit with drep, vote, action, href and snippet', async () => {
    await seedRationale({ gaId: 'ga1', slug: 'raise-treasury', title: 'Raise treasury cap', voterId: 'drep1alice', drepName: 'Alice', vote: 'Yes', bodyHtml: '<p>The treasury runway matters here.</p>' });

    const res = await searchRationalesPage(db(), 'treasury*', 1);
    expect(res.total).toBe(1);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({
      voterId: 'drep1alice',
      name: 'Alice',
      vote: 'Yes',
      actionTitle: 'Raise treasury cap',
      href: '/t/raise-treasury/?tab=positions#voter-drep1alice',
    });
    expect(res.hits[0].snippet).toContain('treasury');
  });

  it('excludes non-ok rationales', async () => {
    await seedRationale({ gaId: 'ga2', slug: 'budget-a', title: 'Budget A', voterId: 'drep1bob', drepName: 'Bob', vote: 'No', bodyHtml: '<p>omega failed doc</p>', status: 'failed' });
    const res = await searchRationalesPage(db(), 'omega*', 1);
    expect(res.total).toBe(0);
    expect(res.hits).toEqual([]);
  });

  it('paginates and counts', async () => {
    for (let i = 0; i < PAGE_SIZE + 2; i++) {
      await seedRationale({ gaId: `pg${i}`, slug: `pg-${i}`, title: `Action ${i}`, voterId: `drep1p${i}`, drepName: `Rep ${i}`, vote: 'Abstain', bodyHtml: `<p>sigma point ${i}</p>` });
    }
    const p1 = await searchRationalesPage(db(), 'sigma*', 1);
    const p2 = await searchRationalesPage(db(), 'sigma*', 2);
    expect(p1.total).toBe(PAGE_SIZE + 2);
    expect(p1.hits).toHaveLength(PAGE_SIZE);
    expect(p2.hits).toHaveLength(2);
    expect((await countScopes(db(), 'sigma*')).rationales).toBe(PAGE_SIZE + 2);
  });
});
