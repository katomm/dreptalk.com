import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createTopic } from './forum.js';
import { buildInsertGovernanceAction } from './governance.js';
import {
  resolveDraftTopic,
  buildDraftLinkStatements,
  getDraftLinkedActions,
  getDraftTopicRef,
  unlinkDraftAction,
} from './draftLinks.js';

const NOW = 1_750_000_000_000;
let n = 0;

async function topic(categorySlug: string, title: string) {
  const { topic } = await createTopic(env.DB, {
    categorySlug, authorId: 'author-1', title, bodyMd: 'x', bodyHtml: '<p>x</p>',
    source: 'user', now: NOW, rand: `r${n++}`,
  });
  return topic;
}

async function action(id: string, topicId: string | null) {
  await buildInsertGovernanceAction(env.DB, {
    id, proposalId: null, type: 'InfoAction', title: `Action ${id}`, abstract: null, rationaleHtml: null,
    authors: null, references: null, anchorUrl: null, anchorHash: null, anchorStatus: 'no-anchor',
    returnAddress: null, deposit: null, submittedEpoch: 1, submittedAt: null, expiryEpoch: null,
    enactedEpoch: null, onchainPayload: null, metaVersion: 1, topicId, now: NOW,
  }).run();
}

const row = (id: string) =>
  env.DB.prepare('SELECT draft_topic_id, draft_link_rejected FROM governance_actions WHERE id = ?').bind(id)
    .first<{ draft_topic_id: string | null; draft_link_rejected: number }>();
const locked = async (id: string) =>
  (await env.DB.prepare('SELECT locked FROM topics WHERE id = ?').bind(id).first<{ locked: number }>())!.locked;

describe('resolveDraftTopic', () => {
  it('returns the first slug that is a live Proposal Drafts thread', async () => {
    const general = await topic('general', 'General thread');
    const draft = await topic('proposal-drafts', 'My draft');
    expect(await resolveDraftTopic(env.DB, ['unknown-x1', general.slug, draft.slug])).toBe(draft.id);
    expect(await resolveDraftTopic(env.DB, [general.slug])).toBeNull();
    expect(await resolveDraftTopic(env.DB, [])).toBeNull();
  });

  it('skips a deleted draft', async () => {
    const draft = await topic('proposal-drafts', 'Deleted draft');
    await env.DB.prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(draft.id).run();
    expect(await resolveDraftTopic(env.DB, [draft.slug])).toBeNull();
  });
});

describe('buildDraftLinkStatements', () => {
  it('links and locks when the action has a topic', async () => {
    const gov = await topic('governance-actions', 'Gov thread');
    const draft = await topic('proposal-drafts', 'Draft A');
    await action('a1#0', gov.id);
    await env.DB.batch(buildDraftLinkStatements(env.DB, 'a1#0', draft.id));
    expect((await row('a1#0'))!.draft_topic_id).toBe(draft.id);
    expect(await locked(draft.id)).toBe(1);
  });

  it('does nothing while the action has no topic', async () => {
    const draft = await topic('proposal-drafts', 'Draft B');
    await action('a2#0', null);
    await env.DB.batch(buildDraftLinkStatements(env.DB, 'a2#0', draft.id));
    expect((await row('a2#0'))!.draft_topic_id).toBeNull();
    expect(await locked(draft.id)).toBe(0);
  });

  it('never moves an existing link and never locks the second draft', async () => {
    const gov = await topic('governance-actions', 'Gov thread C');
    const first = await topic('proposal-drafts', 'Draft C1');
    const second = await topic('proposal-drafts', 'Draft C2');
    await action('a3#0', gov.id);
    await env.DB.batch(buildDraftLinkStatements(env.DB, 'a3#0', first.id));
    await env.DB.batch(buildDraftLinkStatements(env.DB, 'a3#0', second.id));
    expect((await row('a3#0'))!.draft_topic_id).toBe(first.id);
    expect(await locked(second.id)).toBe(0);
  });

  it('does nothing for a rejected action', async () => {
    const gov = await topic('governance-actions', 'Gov thread D');
    const draft = await topic('proposal-drafts', 'Draft D');
    await action('a4#0', gov.id);
    await env.DB.prepare('UPDATE governance_actions SET draft_link_rejected = 1 WHERE id = ?').bind('a4#0').run();
    await env.DB.batch(buildDraftLinkStatements(env.DB, 'a4#0', draft.id));
    expect((await row('a4#0'))!.draft_topic_id).toBeNull();
    expect(await locked(draft.id)).toBe(0);
  });
});

describe('unlinkDraftAction and readers', () => {
  it('unlinks, flags, reopens, and keeps the draft closed while another action remains', async () => {
    const g1 = await topic('governance-actions', 'Gov E1');
    const g2 = await topic('governance-actions', 'Gov E2');
    const draft = await topic('proposal-drafts', 'Draft E');
    await action('e1#0', g1.id);
    await action('e2#0', g2.id);
    await env.DB.batch([
      ...buildDraftLinkStatements(env.DB, 'e1#0', draft.id),
      ...buildDraftLinkStatements(env.DB, 'e2#0', draft.id),
    ]);

    const linked = await getDraftLinkedActions(env.DB, draft.id);
    expect(linked.map((a) => a.id).sort()).toEqual(['e1#0', 'e2#0']);
    expect(linked.find((a) => a.id === 'e1#0')!.topicSlug).toBe(g1.slug);
    expect(await getDraftTopicRef(env.DB, draft.id)).toEqual({ slug: draft.slug, title: 'Draft E' });

    // A deleted governance thread keeps its row (so the author can still unlink), without a slug.
    await env.DB.prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(g2.id).run();
    expect((await getDraftLinkedActions(env.DB, draft.id)).find((a) => a.id === 'e2#0')!.topicSlug).toBeNull();

    expect(await unlinkDraftAction(env.DB, 'e1#0', draft.id)).toBe(true);
    expect(await row('e1#0')).toEqual({ draft_topic_id: null, draft_link_rejected: 1 });
    expect(await locked(draft.id)).toBe(1);

    expect(await unlinkDraftAction(env.DB, 'e2#0', draft.id)).toBe(true);
    expect(await locked(draft.id)).toBe(0);

    expect(await unlinkDraftAction(env.DB, 'e2#0', draft.id)).toBe(false);
  });

  it('getDraftTopicRef hides a deleted draft', async () => {
    const draft = await topic('proposal-drafts', 'Draft F');
    await env.DB.prepare('UPDATE topics SET deleted = 1 WHERE id = ?').bind(draft.id).run();
    expect(await getDraftTopicRef(env.DB, draft.id)).toBeNull();
  });
});
