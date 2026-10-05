/// <reference types="@cloudflare/workers-types" />
// Workers-runtime tests for handleActionStatus, run against real D1 (for the
// governance_actions/topics/draft-link reads), mirroring
// actionContextHandler.workers.test.ts's style: network and env injected via
// deps so every branch is deterministic.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleActionStatus } from './actionStatusHandler.js';
import { createTopic } from '../db/forum.js';
import { buildInsertGovernanceAction } from '../db/governance.js';
import { buildDraftLinkStatements } from '../db/draftLinks.js';

const preprod = { network: 'preprod', networkId: 0 } as never; // minimal NetworkConfig stub
const testEnv = { ...env } as Cloudflare.Env;

const NOW = 1_750_000_000_000;
let n = 0;

function ctx(id: string, user: { id: string; roles: string[] } | null = { id: 'status-user', roles: [] }) {
  const request = new Request(`https://dreptalk.com/api/gov-action/status?id=${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' },
  });
  return { request, locals: { user } as App.Locals };
}

async function topic(categorySlug: string, title: string) {
  const { topic } = await createTopic(env.DB, {
    categorySlug,
    authorId: 'author-1',
    title,
    bodyMd: 'x',
    bodyHtml: '<p>x</p>',
    source: 'user',
    now: NOW,
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

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

describe('handleActionStatus', () => {
  it('401s when signed out', async () => {
    const res = await handleActionStatus(ctx(`${HASH_A}#0`, null), { network: preprod, env: testEnv });
    expect(res.status).toBe(401);
  });

  it('404s on mainnet', async () => {
    const mainnet = { network: 'mainnet', networkId: 1 } as never;
    const res = await handleActionStatus(ctx(`${HASH_A}#0`), { network: mainnet, env: testEnv });
    expect(res.status).toBe(404);
  });

  it('400s on a malformed id', async () => {
    const res = await handleActionStatus(ctx('not-an-id'), { network: preprod, env: testEnv });
    expect(res.status).toBe(400);
  });

  it('answers not synced for an id with no row at all', async () => {
    const res = await handleActionStatus(ctx(`${HASH_A}#0`), { network: preprod, env: testEnv });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ synced: false, slug: null, draft: null });
  });

  it('answers not synced for a row gov-sync wrote before its thread existed', async () => {
    const id = `${HASH_B}#0`;
    await action(id, null);
    const res = await handleActionStatus(ctx(id), { network: preprod, env: testEnv });
    expect(await res.json()).toEqual({ synced: false, slug: null, draft: null });
  });

  it('answers synced with the thread slug and no draft', async () => {
    const gov = await topic('governance-actions', 'Gov thread');
    const id = `${HASH_C}#0`;
    await action(id, gov.id);
    const res = await handleActionStatus(ctx(id), { network: preprod, env: testEnv });
    expect(await res.json()).toEqual({ synced: true, slug: gov.slug, draft: null });
  });

  it('answers synced with the linked draft', async () => {
    const gov = await topic('governance-actions', 'Gov thread 2');
    const draft = await topic('proposal-drafts', 'Fund tooling');
    const id = `${HASH_D}#0`;
    await action(id, gov.id);
    await env.DB.batch(buildDraftLinkStatements(env.DB, id, draft.id));
    const res = await handleActionStatus(ctx(id), { network: preprod, env: testEnv });
    expect(await res.json()).toEqual({
      synced: true,
      slug: gov.slug,
      draft: { slug: draft.slug, title: draft.title },
    });
  });
});
