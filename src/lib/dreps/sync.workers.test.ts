// DRep sync tests -- run in real workerd via @cloudflare/vitest-pool-workers.
// Exercise syncDreps against the real miniflare D1 binding, a fake Koios client,
// and an injected anchor fetch. The focus is the cost-saver invariants:
//   - a DRep whose meta_hash is unchanged since last sync is NOT re-fetched
//   - a row that did not change is NOT written back
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncDreps } from './sync.js';
import { getDrepById } from '../db/dreps.js';
import { putDrepMetadata, getDrepMetadata } from '../db/drepMetadata.js';
import type { DrepListRow, DrepInfoRow } from '../koios/client.js';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';

const NOW = 1_748_000_000_000;

// A valid CIP-119 profile document and its blake2b-256 anchor hash.
const profileDoc = {
  '@context': {},
  hashAlgorithm: 'blake2b-256',
  body: {
    givenName: 'Alice DRep',
    objectives: 'Champion of the test suite.',
    image: 'https://example.com/alice.png',
    references: [{ '@type': 'Link', label: 'Website', uri: 'https://alice.example' }],
  },
};
const profileJson = JSON.stringify(profileDoc);
const profileHash = bytesToHex(blake2b256(new TextEncoder().encode(profileJson)));

function jsonResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}

// A fetch impl that serves the profile doc and counts how many times it ran.
function countingProfileFetch() {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return jsonResponse(profileJson);
  };
  return { fetchImpl, calls: () => calls };
}

// Fake Koios: drepList returns the supplied pages by offset; drepInfoBatch
// returns the rows whose drep_id is in the requested chunk.
function fakeKoios(opts: {
  pages: DrepListRow[][];
  infoById: Map<string, DrepInfoRow>;
}) {
  const drepListCalls: number[] = [];
  return {
    koios: {
      async drepList(_limit: number, offset: number): Promise<DrepListRow[]> {
        drepListCalls.push(offset);
        // Map offset -> page index using a fixed page size of 1000.
        const pageIndex = offset / 1000;
        return opts.pages[pageIndex] ?? [];
      },
      async drepInfoBatch(ids: string[]): Promise<DrepInfoRow[]> {
        return ids
          .map((id) => opts.infoById.get(id))
          .filter((r): r is DrepInfoRow => r != null);
      },
    },
    drepListCalls,
  };
}

function listRow(id: string, registered = true): DrepListRow {
  return { drep_id: id, hex: `${id}-hex`, has_script: false, registered };
}

function infoRow(id: string, over: Partial<DrepInfoRow> = {}): DrepInfoRow {
  return {
    drep_id: id,
    hex: `${id}-hex`,
    has_script: false,
    drep_status: 'active',
    deposit: '500000000',
    active: true,
    expires_epoch_no: 400,
    amount: '1000000000',
    meta_url: null,
    meta_hash: null,
    ...over,
  };
}

describe('syncDreps', () => {
  it('inserts a new DRep with a valid anchor and parses its CIP-119 profile', async () => {
    const id = 'drep1-new-anchored';
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([
        [id, infoRow(id, { meta_url: 'https://example.com/a.json', meta_hash: profileHash })],
      ]),
    });
    const fetcher = countingProfileFetch();

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    expect(result).toMatchObject({ total: 1, updated: 1, skipped: 0, anchorsFetched: 1, failed: 0 });
    expect(fetcher.calls()).toBe(1);

    const stored = await getDrepById(env.DB, id);
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe('Alice DRep');
    expect(stored!.bio).toBe('Champion of the test suite.');
    expect(stored!.imageUrl).toBe('https://example.com/alice.png');
    expect(stored!.links).toEqual([{ label: 'Website', uri: 'https://alice.example' }]);
    expect(stored!.anchorStatus).toBe('ok');
    expect(stored!.anchorHash).toBe(profileHash);
    expect(stored!.status).toBe('active');
    expect(stored!.votingPower).toBe('1000000000');
    expect(stored!.lastSyncedAt).toBe(NOW);
    expect(stored!.createdAt).toBe(NOW);
  });

  it('does NOT re-fetch the anchor and does NOT write when meta_hash is unchanged', async () => {
    const id = 'drep1-unchanged';
    const info = infoRow(id, { meta_url: 'https://example.com/a.json', meta_hash: profileHash });
    const { koios } = fakeKoios({ pages: [[listRow(id)]], infoById: new Map([[id, info]]) });

    // First run: inserts the row and fetches the anchor once.
    const first = countingProfileFetch();
    const r1 = await syncDreps({ koios, db: env.DB, fetchImpl: first.fetchImpl, now: NOW });
    expect(r1).toMatchObject({ total: 1, updated: 1, anchorsFetched: 1 });
    expect(first.calls()).toBe(1);

    const afterFirst = await getDrepById(env.DB, id);
    expect(afterFirst).not.toBeNull();

    // Second run with the SAME meta_hash and identical info: no fetch, no write.
    const second = countingProfileFetch();
    const r2 = await syncDreps({ koios, db: env.DB, fetchImpl: second.fetchImpl, now: NOW + 60_000 });
    expect(r2).toMatchObject({ total: 1, updated: 0, skipped: 1, anchorsFetched: 0, failed: 0 });
    expect(second.calls()).toBe(0);

    // The stored row must be byte-for-byte unchanged, including lastSyncedAt
    // (a write would have bumped it to NOW + 60_000).
    const afterSecond = await getDrepById(env.DB, id);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond!.lastSyncedAt).toBe(NOW);
  });

  it('updates a DRep whose status/active changed without re-fetching the anchor', async () => {
    const id = 'drep1-status-change';
    const map = new Map([
      [id, infoRow(id, { meta_url: 'https://example.com/a.json', meta_hash: profileHash })],
    ]);
    const { koios } = fakeKoios({ pages: [[listRow(id)]], infoById: map });

    const first = countingProfileFetch();
    await syncDreps({ koios, db: env.DB, fetchImpl: first.fetchImpl, now: NOW });
    expect(first.calls()).toBe(1);

    // Change drep_status and active, keep the SAME meta_hash.
    map.set(
      id,
      infoRow(id, {
        meta_url: 'https://example.com/a.json',
        meta_hash: profileHash,
        drep_status: 'retired',
        active: false,
      }),
    );

    const second = countingProfileFetch();
    const r2 = await syncDreps({ koios, db: env.DB, fetchImpl: second.fetchImpl, now: NOW + 1 });
    expect(r2).toMatchObject({ total: 1, updated: 1, skipped: 0, anchorsFetched: 0, failed: 0 });
    expect(second.calls()).toBe(0); // anchor NOT re-fetched

    const stored = await getDrepById(env.DB, id);
    expect(stored!.status).toBe('retired');
    expect(stored!.active).toBe(false);
    // Profile reused from the stored row.
    expect(stored!.name).toBe('Alice DRep');
  });

  it('preserves the stored profile when a re-fetch fails, recording the error status', async () => {
    const id = 'drep1-preserve';
    const map = new Map([
      [id, infoRow(id, { meta_url: 'https://example.com/a.json', meta_hash: profileHash })],
    ]);
    const { koios } = fakeKoios({ pages: [[listRow(id)]], infoById: map });

    // First run stores a good profile.
    await syncDreps({ koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW });
    const afterFirst = await getDrepById(env.DB, id);
    expect(afterFirst!.name).toBe('Alice DRep');
    expect(afterFirst!.anchorStatus).toBe('ok');

    // The DRep advertises a new anchor hash, but the fetched bytes do not match
    // it (stand-in for a transient or corrupt fetch) -> hash-mismatch.
    const newHash = 'a'.repeat(64);
    map.set(id, infoRow(id, { meta_url: 'https://example.com/a.json', meta_hash: newHash }));

    const r2 = await syncDreps({ koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW + 1 });
    expect(r2).toMatchObject({ updated: 1, anchorsFetched: 1, failed: 0 });

    const afterSecond = await getDrepById(env.DB, id);
    // The profile is PRESERVED, not blanked, despite the failed re-fetch.
    expect(afterSecond!.name).toBe('Alice DRep');
    expect(afterSecond!.imageUrl).toBe('https://example.com/alice.png');
    // The error status and new hash are recorded so the next sync retries.
    expect(afterSecond!.anchorStatus).toBe('hash-mismatch');
    expect(afterSecond!.anchorHash).toBe(newHash);
  });

  it('stores the error anchorStatus for a failing anchor and keeps processing others', async () => {
    const bad = 'drep1-bad-anchor';
    const good = 'drep1-good-noanchor';
    const { koios } = fakeKoios({
      pages: [[listRow(bad), listRow(good)]],
      infoById: new Map([
        // meta_hash will not match the served bytes -> hash-mismatch.
        [bad, infoRow(bad, { meta_url: 'https://example.com/bad.json', meta_hash: 'deadbeef' })],
        [good, infoRow(good)],
      ]),
    });
    const fetcher = countingProfileFetch();

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    expect(result.total).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0); // a non-ok anchor is tolerated, not a failure
    expect(result.anchorsFetched).toBe(1); // only the bad one was fetched

    const badRow = await getDrepById(env.DB, bad);
    expect(badRow!.anchorStatus).toBe('hash-mismatch');
    expect(badRow!.name).toBeNull();

    const goodRow = await getDrepById(env.DB, good);
    expect(goodRow!.anchorStatus).toBe('no-anchor');
  });

  it('paginates: a full page followed by a short page enumerates both', async () => {
    // A full page of exactly 1000 ids forces a second drepList call.
    const fullPage: DrepListRow[] = [];
    const infoById = new Map<string, DrepInfoRow>();
    for (let i = 0; i < 1000; i++) {
      const id = `drep1-page-a-${i}`;
      fullPage.push(listRow(id));
      infoById.set(id, infoRow(id));
    }
    const shortPage: DrepListRow[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `drep1-page-b-${i}`;
      shortPage.push(listRow(id));
      infoById.set(id, infoRow(id));
    }

    const { koios, drepListCalls } = fakeKoios({ pages: [fullPage, shortPage], infoById });
    const fetcher = countingProfileFetch();

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    // Two pages enumerated (offset 0 and offset 1000), then a short page stops.
    expect(drepListCalls).toEqual([0, 1000]);
    expect(result.total).toBe(1003);

    // Spot-check one id from each page made it into D1.
    expect(await getDrepById(env.DB, 'drep1-page-a-0')).not.toBeNull();
    expect(await getDrepById(env.DB, 'drep1-page-b-2')).not.toBeNull();
  });

  it('garbage-collects hosted metadata for unregistered drep ids, keeping registered ones', async () => {
    const reg = 'drep1-gc-registered';
    const junk = 'drep1-gc-junk-unregistered';
    const { koios } = fakeKoios({ pages: [[listRow(reg)]], infoById: new Map([[reg, infoRow(reg)]]) });

    // Old hosted metadata: one for the registered drep (keep), one pure junk (delete).
    await putDrepMetadata(env.DB, { drepId: reg, body: '{}', hash: 'a'.repeat(64), name: 'Reg', createdAt: 1000 });
    await putDrepMetadata(env.DB, { drepId: junk, body: '{}', hash: 'b'.repeat(64), name: 'Junk', createdAt: 1000 });

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW });

    expect(result.gcDeleted).toBeGreaterThanOrEqual(1);
    expect(await getDrepMetadata(env.DB, reg)).not.toBeNull(); // registered -> kept
    expect(await getDrepMetadata(env.DB, junk)).toBeNull(); // unregistered junk -> deleted
  });

  it('does NOT garbage-collect when the enumeration is empty (transient empty drep_list)', async () => {
    // A transient empty drep_list must not be read as "no DReps exist" and wipe
    // every hosted document.
    const orphan = 'drep1-empty-enum-orphan';
    await putDrepMetadata(env.DB, { drepId: orphan, body: '{}', hash: 'c'.repeat(64), name: 'Orphan', createdAt: 1000 });
    const { koios } = fakeKoios({ pages: [[]], infoById: new Map() });

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW });

    expect(result.total).toBe(0);
    expect(result.gcDeleted).toBe(0);
    expect(await getDrepMetadata(env.DB, orphan)).not.toBeNull(); // preserved
  });

  it('skips DReps that are not registered', async () => {
    const reg = 'drep1-registered';
    const unreg = 'drep1-unregistered';
    const { koios } = fakeKoios({
      pages: [[listRow(reg, true), listRow(unreg, false)]],
      infoById: new Map([
        [reg, infoRow(reg)],
        [unreg, infoRow(unreg)],
      ]),
    });
    const fetcher = countingProfileFetch();

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    expect(result.total).toBe(1); // only the registered DRep is counted
    expect(await getDrepById(env.DB, reg)).not.toBeNull();
    expect(await getDrepById(env.DB, unreg)).toBeNull();
  });
});
