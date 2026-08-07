/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSearch } from './handler.js';
import { upsertActionRationale } from '../db/actionRationale.js';
import { upsertDrep } from '../db/dreps.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

function drepArgs(id: string, name: string): Parameters<typeof upsertDrep>[1] {
  return {
    drepId: id, hex: null, hasScript: false, status: 'registered', active: true,
    deposit: null, votingPower: '5000000000', expiresEpochNo: null, name, bio: null,
    imageUrl: null, imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null,
    links: null, motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'pending', profileExtractVersion: 0, lastSyncedAt: NOW, createdAt: NOW,
  };
}

async function seedRationale(gaId: string, slug: string, title: string, voterId: string, name: string, vote: string, bodyHtml: string) {
  await db().prepare(
    `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
     VALUES (?, 'governance-actions', 'system', 'governance', ?, ?, 0, ?, ?, 0)`,
  ).bind(`t-${gaId}`, title, slug, NOW, NOW).run();
  await db().prepare(
    `INSERT INTO governance_actions (id, proposal_id, type, title, status, topic_id, created_at, last_synced_at)
     VALUES (?, ?, 'InfoAction', ?, 'enacted', ?, ?, ?)`,
  ).bind(gaId, `p_${gaId}`, title, `t-${gaId}`, NOW, NOW).run();
  await upsertDrep(db(), drepArgs(voterId, name));
  await db().prepare(
    `INSERT INTO drep_votes (ga_id, voter_role, voter_id, vote, synced_at, block_time) VALUES (?, 'DRep', ?, ?, ?, ?)`,
  ).bind(gaId, voterId, vote, NOW, 1_700_000_000).run();
  await upsertActionRationale(db(), { gaId, voterId, bodyHtml, source: 'onchain', anchorUrl: 'https://x', status: 'ok', createdAt: NOW, now: NOW });
}

describe('handleSearch rationales scope', () => {
  it('rationales scope returns only rationales with a total', async () => {
    await seedRationale('ga1', 'raise-cap', 'Raise cap', 'drep1x', 'Xavier', 'Yes', '<p>treasury runway concern</p>');
    const body = await handleSearch(db(), 'treasury', { scope: 'rationales', page: 1 });
    expect(body.scope).toBe('rationales');
    expect(body.rationales).toHaveLength(1);
    expect(body.rationales[0].vote).toBe('Yes');
    expect(body.rationales[0].name).toBe('Xavier');
    expect(body.governanceActions).toEqual([]);
    expect(body.discussions).toEqual([]);
    expect(body.total).toBe(1);
  });

  it('all page mode includes a rationales count', async () => {
    await seedRationale('ga2', 'budget-b', 'Budget B', 'drep1y', 'Yolanda', 'No', '<p>epsilon budget note</p>');
    const body = await handleSearch(db(), 'epsilon', { scope: 'all', counts: true });
    expect(body.counts?.rationales).toBe(1);
    expect(body.rationales.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBeNull();
  });
});
