/// <reference types="@cloudflare/workers-types" />
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { hashBytes } from './codec.js';
import { PROFILE_DOC_GRACE_MS } from './constants.js';
import { buildProfileDoc, gcProfileDocs, getProfileDocBody, putProfileDoc } from './profileDocs.js';

const db = env.DB as D1Database;
const NOW = 2_000_000_000_000;
const OLD = NOW - PROFILE_DOC_GRACE_MS - 1000;
const hex = (c: string): string => c.repeat(64);

const put = (hash: string, at = OLD) => putProfileDoc(db, { hash, body: `{"h":"${hash}"}`, createdBy: 'u1', now: at });
const exists = async (hash: string): Promise<boolean> => (await getProfileDocBody(db, hash)) !== null;
const anchored = async (hash: string): Promise<number> =>
  (await db.prepare('SELECT anchored FROM drep_group_profile_docs WHERE hash = ?').bind(hash).first<{ anchored: number }>())!.anchored;
const pending = (id: string, profileHash: string, resolution: string | null, at: number | null) =>
  db
    .prepare(
      `INSERT INTO pending_multisig_tx (id, drep_id, action, action_params, unsigned_tx_cbor, body_hash, native_script, created_by, created_at, expires_at,
         subject_kind, profile_hash, resolution, resolved_at, never_included_at)
       VALUES (?, 'g', 'group', '{}', '00', ?, '{}', 'u1', ?, ?, 'group', ?, ?, ?, ?)`,
    )
    .bind(id, hex('e'), OLD, NOW, profileHash, resolution, at, resolution === 'never_included' ? at : null)
    .run();

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM drep_group_profile_docs'),
    db.prepare('DELETE FROM drep_group_anchor_refs'),
    db.prepare("DELETE FROM pending_multisig_tx WHERE subject_kind = 'group'"),
  ]);
});

describe('profile documents', () => {
  it('hashes the exact bytes it stores and serves', async () => {
    const { body, hash } = buildProfileDoc({ name: 'Council', website: 'https://c.test' });
    expect(hash).toBe(bytesToHex(blake2b256(new TextEncoder().encode(body))));
    const parsed = JSON.parse(body);
    expect(parsed.hashAlgorithm).toBe('blake2b-256');
    expect(parsed['@context'].body['@context'].name).toBe('DRG:name');
    expect(parsed.body).toEqual({ name: 'Council', website: 'https://c.test' });
    await putProfileDoc(db, { hash, body, createdBy: 'u1', now: NOW });
    expect(await getProfileDocBody(db, hash)).toBe(body);
  });

  it('never clears the anchored mark when the same bytes are stored again', async () => {
    await put(hex('a'));
    await db.prepare('UPDATE drep_group_profile_docs SET anchored = 1 WHERE hash = ?').bind(hex('a')).run();
    await put(hex('a'), NOW);
    expect(await anchored(hex('a'))).toBe(1);
  });

  it('keeps a document stored before the processed position and anchored after it', async () => {
    await put(hex('a'));
    await pending('p1', hex('a'), null, null);
    expect((await gcProfileDocs(db, NOW)).deleted).toBe(0);
    await db.prepare('UPDATE drep_group_profile_docs SET anchored = 1 WHERE hash = ?').bind(hex('a')).run();
    await db.prepare("UPDATE pending_multisig_tx SET resolution = 'failed', resolved_at = ? WHERE id = 'p1'").bind(OLD).run();
    expect((await gcProfileDocs(db, NOW)).deleted).toBe(0);
    expect(await exists(hex('a'))).toBe(true);
  });

  it('deletes an unanchored document only after a failed or never included row aged past the grace', async () => {
    await put(hex('a'));
    await put(hex('b'));
    await put(hex('c'));
    await put(hex('d'));
    await put(hex('f'), NOW);
    await pending('p-fail-old', hex('a'), 'failed', OLD);
    await pending('p-ni-old', hex('b'), 'never_included', OLD);
    await pending('p-fail-new', hex('c'), 'failed', NOW - 1000);
    await pending('p-applied', hex('d'), 'applied', OLD);
    expect((await gcProfileDocs(db, NOW)).deleted).toBe(2);
    expect(await exists(hex('a'))).toBe(false);
    expect(await exists(hex('b'))).toBe(false);
    expect(await exists(hex('c'))).toBe(true);
    expect(await exists(hex('d'))).toBe(true);
    expect(await exists(hex('f'))).toBe(true);
  });

  it('deletes a document with no referencing row after the grace', async () => {
    await put(hex('a'));
    await put(hex('b'), NOW);
    expect((await gcProfileDocs(db, NOW)).deleted).toBe(1);
    expect(await exists(hex('a'))).toBe(false);
    expect(await exists(hex('b'))).toBe(true);
  });

  it('keeps an anchored document after a later profile change', async () => {
    await put(hex('a'));
    await db.prepare('UPDATE drep_group_profile_docs SET anchored = 1 WHERE hash = ?').bind(hex('a')).run();
    await pending('p1', hex('a'), 'failed', OLD);
    expect((await gcProfileDocs(db, NOW)).deleted).toBe(0);
    expect(await exists(hex('a'))).toBe(true);
  });

  it('keeps a document referenced by a stored unprocessed tx without any pending row', async () => {
    await put(hex('a'));
    await put(hex('b'));
    await db.prepare('INSERT INTO drep_group_anchor_refs (hash, tx_hash) VALUES (?, ?)').bind(hashBytes(hex('a')), hashBytes(hex('9'))).run();
    expect((await gcProfileDocs(db, NOW)).deleted).toBe(1);
    expect(await exists(hex('a'))).toBe(true);
    expect(await exists(hex('b'))).toBe(false);
  });

  it('deletes at most 200 per run and drains over runs', async () => {
    const hashes = Array.from({ length: 230 }, (_, i) => i.toString(16).padStart(64, '0'));
    await db.batch(
      hashes.map((h) => db.prepare('INSERT INTO drep_group_profile_docs (hash, body, created_by, created_at) VALUES (?, ?, ?, ?)').bind(h, '{}', 'u1', OLD)),
    );
    expect((await gcProfileDocs(db, NOW)).deleted).toBe(200);
    expect((await gcProfileDocs(db, NOW)).deleted).toBe(30);
  });

  it('keeps a document that is posted again between the candidate read and the delete', async () => {
    await put(hex('a'));
    const real = db.batch.bind(db);
    let first = true;
    const racing = Object.create(db) as D1Database;
    racing.prepare = db.prepare.bind(db);
    racing.batch = (async (stmts: D1PreparedStatement[]) => {
      if (!first) return real(stmts);
      first = false;
      const out = await real(stmts);
      await put(hex('a'), NOW);
      return out;
    }) as D1Database['batch'];
    expect((await gcProfileDocs(racing, NOW)).deleted).toBe(1);
    expect(await exists(hex('a'))).toBe(true);
  });
});
