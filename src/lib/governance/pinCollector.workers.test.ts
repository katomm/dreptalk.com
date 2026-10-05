/// <reference types="@cloudflare/workers-types" />
// The collector deletes files on a Pinata account SHARED with another project,
// so these tests are the guard on that. The fake client fails the test if the
// collector ever reaches for anything but a read or a delete by id, which is
// what keeps a future refactor from introducing a list call.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { putGovActionMetadata, serveGovActionMetadata } from '../db/govActionMetadata.js';
import { collectUnreferencedPins } from './pinCollector.js';
import type { PinataFileRemover, RemoveOutcome } from './pinata.js';

const NOW = 1_800_000_000;
const DAY = 86_400;
const GRACE = 7 * DAY;
const OURS = 'group-dreptalk';

/**
 * Records every call so a test can assert exactly which ones happened. The
 * group check now lives inside removeFile (pinata.ts), so this fake models that
 * contract: it is handed the required group and answers with the outcome.
 */
function fakeRemover(
  over: { groups?: Record<string, string | null>; missing?: Set<string>; fail?: Set<string> } = {},
): PinataFileRemover & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async removeFile(fileId, requireGroup): Promise<RemoveOutcome> {
      calls.push(fileId);
      if (over.fail?.has(fileId)) throw new Error('pinata delete failed: 500');
      if (over.missing?.has(fileId)) return 'already-gone';
      // `in`, not `??`: a file explicitly configured with a null group must stay
      // null, which is exactly the case the group check exists to catch.
      const groupId = over.groups && fileId in over.groups ? over.groups[fileId] : OURS;
      return groupId === requireGroup ? 'removed' : 'not-ours';
    },
  };
}

// Confirmed shape against mainnet Koios (gov_action1jxne7hynfd7frcczwumd2eggps4kvy0msjztz9t0mutpy870ksgqqp6vp3p,
// ratified epoch 608): proposal_description for a NewConstitution action, exactly
// as stored via JSON.stringify(p.proposal_description) in sync.ts. The
// constitution hash sits at contents[1].anchor.dataHash, lowercase hex, and it
// is a different value from the action's own meta_hash (the CIP-108 anchor_hash
// of the proposal's own metadata document, unrelated to the constitution text).
function newConstitutionPayload(dataHash: string): string {
  return JSON.stringify({
    tag: 'NewConstitution',
    contents: [
      { txId: '8c653ee5c9800e6d31e79b5a7f7d4400c81d44717ad4db633dc18d4c07e4a4fd', govActionIx: 0 },
      {
        anchor: { url: 'ipfs://bafkreieyuknozbtewyurfqoagvplvykadn6a4u6wglupavdz46bbsnnl6e', dataHash },
        script: 'fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64',
      },
    ],
  });
}

async function insertOld(hash: string, fileId: string | null, servedAt = NOW - GRACE - DAY) {
  await putGovActionMetadata(env.DB, {
    hash,
    cid: `cid-${hash.slice(0, 4)}`,
    body: '{}',
    createdAt: servedAt,
    pinataFileId: fileId,
  });
}

const run = (remover: PinataFileRemover, limit = 200) =>
  collectUnreferencedPins({ db: env.DB, remover, groupId: OURS, now: NOW, limit });

describe('collectUnreferencedPins', () => {
  it('deletes an unreferenced pin and drops its row', async () => {
    const hash = 'a'.repeat(64);
    await insertOld(hash, 'file-a');
    const client = fakeRemover();
    const res = await run(client);
    expect(res).toMatchObject({ scanned: 1, deleted: 1, failed: 0, foreign: 0, backlog: 0 });
    expect(client.calls).toEqual(['file-a']);
    expect(await serveGovActionMetadata(env.DB, hash, NOW)).toBeNull();
  });

  // THE test of this module. A file outside our group is another project's, and
  // no combination of the other conditions may override that.
  it('refuses to delete a file that is not in our group, and keeps the row', async () => {
    const hash = 'b'.repeat(64);
    await insertOld(hash, 'file-claimpaign');
    const client = fakeRemover({ groups: { 'file-claimpaign': 'group-other' } });
    const res = await run(client);
    expect(res).toMatchObject({ deleted: 0, foreign: 1 });
    expect(client.calls).toEqual(['file-claimpaign']);
    expect((await serveGovActionMetadata(env.DB, hash, NOW))?.cid).toBe('cid-bbbb');

    // And it is never reconsidered: the id is forgotten, so a second run does
    // not read the foreign file again or repeat the alarm.
    const second = fakeRemover({ groups: { 'file-claimpaign': 'group-other' } });
    const again = await collectUnreferencedPins({
      db: env.DB, remover: second, groupId: OURS, now: NOW, limit: 200,
    });
    expect(again).toMatchObject({ scanned: 0, foreign: 0 });
    expect(second.calls).toEqual([]);
  });

  it('refuses a file with no group at all', async () => {
    await insertOld('c'.repeat(64), 'file-ungrouped');
    const client = fakeRemover({ groups: { 'file-ungrouped': null } });
    const res = await run(client);
    expect(res).toMatchObject({ deleted: 0, foreign: 1 });
    expect(client.calls).toEqual(['file-ungrouped']);
  });

  it('never calls anything but read and delete by id', async () => {
    await insertOld('d'.repeat(64), 'file-d');
    const client = fakeRemover();
    await run(client);
    // There is no list capability on the remover interface at all, which is the
    // point: enumeration of a shared account is not something a future caller
    // can reach for by accident.
    expect(client.calls).toEqual(['file-d']);
  });

  it('clears the row for a file Pinata no longer has', async () => {
    const hash = 'e'.repeat(64);
    await insertOld(hash, 'file-gone');
    const client = fakeRemover({ missing: new Set(['file-gone']) });
    const res = await run(client);
    expect(res).toMatchObject({ deleted: 1 });
    expect(client.calls).toEqual(['file-gone']);
    expect(await serveGovActionMetadata(env.DB, hash, NOW)).toBeNull();
  });

  it('keeps the row and counts the attempt when the delete fails', async () => {
    const hash = 'f'.repeat(64);
    await insertOld(hash, 'file-f');
    const client = fakeRemover({ fail: new Set(['file-f']) });
    const res = await run(client);
    expect(res).toMatchObject({ deleted: 0, failed: 1 });
    // The row survives, and is released rather than left claimed.
    expect((await serveGovActionMetadata(env.DB, hash, NOW))?.cid).toBe('cid-ffff');
  });

  it('leaves an anchored document alone', async () => {
    const hash = '1'.repeat(64);
    await insertOld(hash, 'file-1');
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, anchor_hash, anchor_status, status, meta_version, topic_id, created_at, last_synced_at)
       VALUES (?, 'InfoAction', ?, 'ok', 'active', 5, 'topic-1', 1, 1)`,
    )
      .bind('tx-1#0', hash)
      .run();
    const client = fakeRemover();
    const res = await run(client);
    expect(res).toMatchObject({ scanned: 0, deleted: 0 });
    expect(client.calls).toEqual([]);
  });

  it('leaves a document inside its grace window alone', async () => {
    await insertOld('2'.repeat(64), 'file-2', NOW - DAY);
    const client = fakeRemover();
    expect(await run(client)).toMatchObject({ scanned: 0, deleted: 0 });
    expect(client.calls).toEqual([]);
  });

  it('leaves a constitution document referenced by a NewConstitution payload alone', async () => {
    const hash = 'b368bdad83c727bbfe86425575233fb914eb76d05d89497f7790cf007fd95f52';
    await insertOld(hash, 'file-g');
    await env.DB.prepare(`UPDATE gov_action_metadata SET kind = 'constitution' WHERE hash = ?`).bind(hash).run();
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, onchain_payload, status, meta_version, topic_id, created_at, last_synced_at)
       VALUES (?, 'NewConstitution', ?, 'active', 5, 'topic-g', 1, 1)`,
    )
      .bind(
        'gov_action1jxne7hynfd7frcczwumd2eggps4kvy0msjztz9t0mutpy870ksgqqp6vp3p',
        newConstitutionPayload(hash),
      )
      .run();
    const client = fakeRemover();
    const res = await run(client);
    expect(res).toMatchObject({ scanned: 0, deleted: 0 });
    expect(client.calls).toEqual([]);
  });

  it('deletes a constitution document referenced nowhere', async () => {
    const hash = 'h'.repeat(64);
    await insertOld(hash, 'file-h');
    await env.DB.prepare(`UPDATE gov_action_metadata SET kind = 'constitution' WHERE hash = ?`).bind(hash).run();
    const client = fakeRemover();
    const res = await run(client);
    expect(res).toMatchObject({ scanned: 1, deleted: 1 });
    expect(client.calls).toEqual(['file-h']);
  });

  it('deletes a constitution document when the NewConstitution payload carries a different dataHash', async () => {
    const hash = 'b368bdad83c727bbfe86425575233fb914eb76d05d89497f7790cf007fd95f52';
    const otherHash = 'c479cebe94d838cc0e97536686344dc025fc87e16e9a598e888dc11806f63001';
    await insertOld(hash, 'file-i');
    await env.DB.prepare(`UPDATE gov_action_metadata SET kind = 'constitution' WHERE hash = ?`).bind(hash).run();
    await env.DB.prepare(
      `INSERT INTO governance_actions (id, type, onchain_payload, status, meta_version, topic_id, created_at, last_synced_at)
       VALUES (?, 'NewConstitution', ?, 'active', 5, 'topic-i', 1, 1)`,
    )
      .bind('gov_action1other', newConstitutionPayload(otherHash))
      .run();
    // The stored payload references a different constitution entirely, so this
    // row must not be protected by it.
    const client = fakeRemover();
    const res = await run(client);
    expect(res).toMatchObject({ scanned: 1, deleted: 1 });
    expect(client.calls).toEqual(['file-i']);
  });

  it('reports the remaining backlog so overload is visible', async () => {
    for (let i = 0; i < 3; i++) await insertOld(`${'3'.repeat(63)}${i}`, `file-3${i}`);
    const res = await run(fakeRemover(), 1);
    expect(res.scanned).toBe(1);
    expect(res.deleted).toBe(1);
    expect(res.backlog).toBe(2);
  });
});
