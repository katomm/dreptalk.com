// Workers test for the Proposal Drafts query the submit form's "Link a
// Proposal Draft" control reads. Seeding mirrors draftLinks.workers.test.ts:
// createTopic for the threads, buildInsertGovernanceAction plus
// buildDraftLinkStatements for a real link (not a raw column poke), so the
// query is exercised against the same shape gov-sync writes.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from './forum.js';
import { buildInsertGovernanceAction } from './governance.js';
import { buildDraftLinkStatements } from './draftLinks.js';
import { listOpenProposalDrafts } from './proposalDrafts.js';

const NOW = 1_750_000_000_000;
let n = 0;

async function topic(categorySlug: string, title: string, authorId: string) {
  const { topic } = await createTopic(env.DB, {
    categorySlug,
    authorId,
    title,
    bodyMd: 'x',
    bodyHtml: '<p>x</p>',
    source: 'user',
    now: NOW + n,
    rand: `r${n++}`,
  });
  return topic;
}

async function action(id: string, topicId: string | null) {
  await buildInsertGovernanceAction(env.DB, {
    id,
    proposalId: null,
    type: 'InfoAction',
    title: `Action ${id}`,
    abstract: null,
    rationaleHtml: null,
    authors: null,
    references: null,
    anchorUrl: null,
    anchorHash: null,
    anchorStatus: 'no-anchor',
    returnAddress: null,
    deposit: null,
    submittedEpoch: 1,
    submittedAt: null,
    expiryEpoch: null,
    enactedEpoch: null,
    onchainPayload: null,
    metaVersion: 1,
    topicId,
    now: NOW,
  }).run();
}

describe('listOpenProposalDrafts', () => {
  it('returns only the open, unlinked, unlocked drafts, own first', async () => {
    const own = await topic('proposal-drafts', 'My draft', 'viewer-1');
    const other = await topic('proposal-drafts', 'Someone else draft', 'other-1');
    const linkedDraft = await topic('proposal-drafts', 'Linked draft', 'viewer-1');
    const lockedDraft = await topic('proposal-drafts', 'Locked draft', 'viewer-1');
    const deletedDraft = await topic('proposal-drafts', 'Deleted draft', 'viewer-1');
    // A thread in a different category must never show up here even if it
    // otherwise looks open.
    await topic('general', 'Not a draft', 'viewer-1');

    const gov = await topic('governance-actions', 'Gov thread', 'viewer-1');
    await action('pd1#0', gov.id);
    await env.DB.batch(buildDraftLinkStatements(env.DB, 'pd1#0', linkedDraft.id));

    await env.DB.prepare('UPDATE topics SET locked = 1 WHERE id = ?').bind(lockedDraft.id).run();
    await env.DB.prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(deletedDraft.id).run();

    const drafts = await listOpenProposalDrafts(env.DB, 'viewer-1');
    expect(drafts.map((d) => d.slug)).toEqual([own.slug, other.slug]);
    // The author id itself stays inside the query: the control only needs to
    // know whether the viewer wrote the draft.
    expect(drafts[0]).toMatchObject({ slug: own.slug, title: 'My draft', own: true });
    expect(drafts[1]).toMatchObject({ slug: other.slug, title: 'Someone else draft', own: false });
    expect('authorId' in drafts[0]).toBe(false);
  });

  it('orders own drafts newest first among themselves, then the rest newest first', async () => {
    const olderOwn = await topic('proposal-drafts', 'Older own', 'viewer-2');
    const newerOwn = await topic('proposal-drafts', 'Newer own', 'viewer-2');
    const olderOther = await topic('proposal-drafts', 'Older other', 'other-2');
    const newerOther = await topic('proposal-drafts', 'Newer other', 'other-2');

    const drafts = await listOpenProposalDrafts(env.DB, 'viewer-2');
    expect(drafts.map((d) => d.slug)).toEqual([newerOwn.slug, olderOwn.slug, newerOther.slug, olderOther.slug]);
  });
});
