/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSearch } from './handler.js';
import { upsertDrep } from '../db/dreps.js';
import { encodeBech32 } from '../crypto/bech32.js';

const db = () => env.DB;
const NOW = 1_749_000_000_000;

function drepArgs(id: string, hex: string, name: string): Parameters<typeof upsertDrep>[1] {
  return {
    drepId: id, hex, hasScript: false, status: 'registered', active: true,
    deposit: null, votingPower: '5000000000', expiresEpochNo: null, name, bio: null,
    imageUrl: null, imageContentHash: null, imageStoredUrl: null, imageFetchFailedAt: null,
    links: null, motivations: null, qualifications: null, paymentAddress: null, doNotList: false,
    anchorUrl: null, anchorHash: null, anchorStatus: 'pending', profileExtractVersion: 0, lastSyncedAt: NOW, createdAt: NOW,
  };
}

describe('handleSearch identifier fast-path under a filter', () => {
  it('resolves a pasted CIP-129 DRep id while the dreps filter is active', async () => {
    const hash = new Uint8Array(28).fill(0xab);
    const hex = 'ab'.repeat(28);
    const cip129 = encodeBech32('drep', new Uint8Array([0x22, ...hash]));
    await upsertDrep(db(), drepArgs('drep1stored', hex, 'Stored DRep'));

    const body = await handleSearch(db(), cip129, { scope: 'dreps', page: 1, counts: true });
    expect(body.exact).toEqual({ kind: 'drep', href: '/dreps/drep1stored/', label: 'Stored DRep' });
  });

  it('resolves a pasted governance id while the governance filter is active', async () => {
    await db().prepare(
      `INSERT INTO topics (id, category_slug, author_id, source, title, slug, post_count, last_post_at, created_at, deleted)
       VALUES ('gt1', 'governance-actions', 'system', 'governance', 'The Action', 'ga-slug', 0, ?, ?, 0)`,
    ).bind(NOW, NOW).run();
    await db().prepare(
      `INSERT INTO governance_actions (id, proposal_id, type, title, status, topic_id, created_at, last_synced_at)
       VALUES ('gaid#0', 'gov_action1one', 'InfoAction', 'The Action', 'active', 'gt1', ?, ?)`,
    ).bind(NOW, NOW).run();

    const body = await handleSearch(db(), 'gov_action1one', { scope: 'governance', page: 1, counts: true });
    expect(body.exact).toEqual({ kind: 'governance-action', href: '/t/ga-slug/', label: 'The Action' });
  });

  it('leaves exact null for free-text scoped queries', async () => {
    const body = await handleSearch(db(), 'treasury runway', { scope: 'dreps', page: 1 });
    expect(body.exact).toBeNull();
  });
});
