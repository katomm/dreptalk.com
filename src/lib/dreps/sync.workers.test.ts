// DRep sync tests -- run in real workerd via @cloudflare/vitest-pool-workers.
// Exercise syncDreps against the real miniflare D1 binding, a fake Koios client,
// and an injected anchor fetch. The focus is the cost-saver invariants:
//   - a DRep whose meta_hash is unchanged since last sync is NOT re-fetched
//   - a row that did not change is NOT written back
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { syncDreps } from './sync.js';
import { PROFILE_EXTRACT_VERSION } from '../governance/metadata.js';
import { getDrepById, upsertDrep } from '../db/dreps.js';
import { putDrepMetadata, getDrepMetadataByHash } from '../db/drepMetadata.js';
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
    motivations: 'To improve governance.',
    paymentAddress: `addr_test1qz${'a'.repeat(40)}`,
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
    expect(stored!.motivations).toBe('To improve governance.');
    expect(stored!.paymentAddress).toBe(`addr_test1qz${'a'.repeat(40)}`);
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

  it('stamps metadata_last_updated_at when a known row changes its anchor hash', async () => {
    const id = 'drep1-meta-stamp';
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([
        [id, infoRow(id, { meta_url: 'https://example.com/a.json', meta_hash: profileHash })],
      ]),
    });

    // First run inserts the row: no stamp, the backfill owns the initial value.
    const first = countingProfileFetch();
    await syncDreps({ koios, db: env.DB, fetchImpl: first.fetchImpl, now: NOW });
    expect((await getDrepById(env.DB, id))!.metadataLastUpdatedAt).toBeNull();

    // Unchanged hash: no write, no stamp.
    await syncDreps({ koios, db: env.DB, fetchImpl: first.fetchImpl, now: NOW + 60_000 });
    expect((await getDrepById(env.DB, id))!.metadataLastUpdatedAt).toBeNull();

    // The DRep publishes new metadata: different doc, different meta_hash.
    const doc2 = { ...profileDoc, body: { ...profileDoc.body, objectives: 'Now with fresh objectives.' } };
    const json2 = JSON.stringify(doc2);
    const hash2 = bytesToHex(blake2b256(new TextEncoder().encode(json2)));
    const { koios: koios2 } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([
        [id, infoRow(id, { meta_url: 'https://example.com/a.json', meta_hash: hash2 })],
      ]),
    });
    const fetch2: typeof fetch = async () => jsonResponse(json2);
    const later = NOW + 3_600_000;
    await syncDreps({ koios: koios2, db: env.DB, fetchImpl: fetch2, now: later });

    const stored = await getDrepById(env.DB, id);
    expect(stored!.anchorHash).toBe(hash2);
    expect(stored!.bio).toBe('Now with fresh objectives.');
    expect(stored!.metadataLastUpdatedAt).toBe(Math.floor(later / 1000));
  });

  it('re-fetches and re-extracts an ok row stored at a stale profile-extract version', async () => {
    // The version gate is how a parser fix heals already-stored rows: an 'ok' row
    // whose anchor hash is unchanged is normally reused with no fetch, but a stale
    // profile_extract_version must force one re-fetch so the new extractor runs.
    const id = 'drep1-stale-version';
    await upsertDrep(env.DB, {
      drepId: id, hex: `${id}-hex`, hasScript: false, status: 'active', active: true,
      deposit: '500000000', votingPower: '1000000000', expiresEpochNo: 400,
      // Simulates the bug's aftermath: an ok row with the name dropped.
      name: null, bio: null, imageUrl: null, imageContentHash: null, imageStoredUrl: null,
      imageFetchFailedAt: null, links: null, motivations: null, qualifications: null,
      paymentAddress: null, doNotList: false,
      anchorUrl: 'https://example.com/a.json', anchorHash: profileHash, anchorStatus: 'ok',
      profileExtractVersion: 0, lastSyncedAt: 1, createdAt: 1,
    });

    const info = infoRow(id, { meta_url: 'https://example.com/a.json', meta_hash: profileHash });
    const { koios } = fakeKoios({ pages: [[listRow(id)]], infoById: new Map([[id, info]]) });
    const fetcher = countingProfileFetch();
    const res = await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    // Re-fetched despite the unchanged hash, and the name is recovered.
    expect(fetcher.calls()).toBe(1);
    expect(res).toMatchObject({ anchorsFetched: 1, updated: 1 });
    const healed = await getDrepById(env.DB, id);
    expect(healed!.name).toBe('Alice DRep');
    expect(healed!.profileExtractVersion).toBe(PROFILE_EXTRACT_VERSION);
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

  // Writes 1003 DRep rows through D1, by far the heaviest case in this file: it
  // finishes in well under a second locally but has timed out at the default 5s
  // on a loaded CI runner, so it gets room rather than reporting a red build for
  // being slow. A real hang still fails, just later.
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
  }, 30_000);

  it('garbage-collects hosted metadata for unregistered drep ids, keeping registered ones', async () => {
    const reg = 'drep1-gc-registered';
    const junk = 'drep1-gc-junk-unregistered';
    const { koios } = fakeKoios({ pages: [[listRow(reg)]], infoById: new Map([[reg, infoRow(reg)]]) });

    // Old hosted metadata: one for the registered drep (keep), one pure junk (delete).
    await putDrepMetadata(env.DB, { drepId: reg, body: '{}', hash: 'a'.repeat(64), name: 'Reg', createdAt: 1000 });
    await putDrepMetadata(env.DB, { drepId: junk, body: '{}', hash: 'b'.repeat(64), name: 'Junk', createdAt: 1000 });

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW });

    expect(result.gcDeleted).toBeGreaterThanOrEqual(1);
    expect(await getDrepMetadataByHash(env.DB, 'a'.repeat(64))).not.toBeNull(); // registered -> kept
    expect(await getDrepMetadataByHash(env.DB, 'b'.repeat(64))).toBeNull(); // unregistered junk -> deleted
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
    expect(await getDrepMetadataByHash(env.DB, 'c'.repeat(64))).not.toBeNull(); // preserved
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

describe('anchor fetch budget', () => {
  it('defers anchor fetches beyond maxAnchorFetches and resumes on the next run', async () => {
    const ids = ['drep1-budget-a', 'drep1-budget-b', 'drep1-budget-c'];
    const infoById = new Map(
      ids.map((id) => [
        id,
        infoRow(id, { meta_url: `https://example.com/${id}.json`, meta_hash: profileHash }),
      ]),
    );
    const { koios } = fakeKoios({ pages: [ids.map((id) => listRow(id))], infoById });

    // First run: budget of 1 fetch; the other two DReps are deferred.
    const first = countingProfileFetch();
    const r1 = await syncDreps({
      koios, db: env.DB, fetchImpl: first.fetchImpl, now: NOW, maxAnchorFetches: 1,
    });
    expect(r1).toMatchObject({ total: 3, anchorsFetched: 1, anchorsDeferred: 2, failed: 0 });
    expect(first.calls()).toBe(1);

    // Deferred rows are written with the chain fields current and the profile
    // marked deferred, so the next run knows to fetch.
    const deferredRows = await Promise.all(ids.map((id) => getDrepById(env.DB, id)));
    const statuses = deferredRows.map((r) => r!.anchorStatus).sort();
    expect(statuses).toEqual(['deferred', 'deferred', 'ok']);

    // Second run without a budget: only the two deferred anchors are fetched
    // (the completed one stays on the no-fetch reuse path).
    const second = countingProfileFetch();
    const r2 = await syncDreps({ koios, db: env.DB, fetchImpl: second.fetchImpl, now: NOW + 1 });
    expect(r2).toMatchObject({ anchorsFetched: 2, anchorsDeferred: 0, failed: 0 });
    expect(second.calls()).toBe(2);

    for (const id of ids) {
      const row = await getDrepById(env.DB, id);
      expect(row!.anchorStatus).toBe('ok');
      expect(row!.name).toBe('Alice DRep');
    }
  });

  it('repeated deferral does not rewrite an unchanged deferred row', async () => {
    const id = 'drep1-budget-stable';
    const infoById = new Map([
      [id, infoRow(id, { meta_url: 'https://example.com/stable.json', meta_hash: profileHash })],
    ]);
    const { koios } = fakeKoios({ pages: [[listRow(id)]], infoById });

    const r1 = await syncDreps({
      koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW, maxAnchorFetches: 0,
    });
    expect(r1).toMatchObject({ anchorsDeferred: 1, updated: 1 });
    const afterFirst = await getDrepById(env.DB, id);
    expect(afterFirst!.anchorStatus).toBe('deferred');

    // Same budget again: still deferred, but nothing changed, so no write.
    const r2 = await syncDreps({
      koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW + 1, maxAnchorFetches: 0,
    });
    expect(r2).toMatchObject({ anchorsDeferred: 1, updated: 0, skipped: 1 });
    expect((await getDrepById(env.DB, id))!.lastSyncedAt).toBe(NOW);
  });
});

describe('deregistration', () => {
  // A registered DRep that disappears from the registered enumeration (deposit
  // returned) must be transitioned to inactive so it stops showing as a live,
  // voting DRep, while its profile is kept for the governance record.
  const anchored = (id: string, over: Partial<DrepInfoRow> = {}): DrepInfoRow =>
    infoRow(id, { meta_url: `https://example.com/${id}.json`, meta_hash: profileHash, ...over });

  it('deactivates a DRep that left the registered set, preserving its stored profile', async () => {
    const stay = 'drep1-dereg-stay';
    const gone = 'drep1-dereg-gone';

    // Run 1: both registered and active, each with a CIP-119 profile.
    const r1 = fakeKoios({
      pages: [[listRow(stay), listRow(gone)]],
      infoById: new Map([[stay, anchored(stay)], [gone, anchored(gone)]]),
    });
    await syncDreps({ koios: r1.koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW });
    const goneAfter1 = await getDrepById(env.DB, gone);
    expect(goneAfter1!.active).toBe(true);
    expect(goneAfter1!.name).toBe('Alice DRep');
    expect(goneAfter1!.votingPower).toBe('1000000000');

    // Run 2: `gone` deregistered (registered:false in drep_list); drep_info now
    // reports the deregistered chain state with zero voting power.
    const r2k = fakeKoios({
      pages: [[listRow(stay, true), listRow(gone, false)]],
      infoById: new Map([
        [stay, anchored(stay)],
        [gone, infoRow(gone, { drep_status: 'deregistered', active: false, amount: '0', deposit: null, meta_url: null, meta_hash: null })],
      ]),
    });
    const fetcher = countingProfileFetch();
    const r2 = await syncDreps({ koios: r2k.koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW + 1 });

    expect(r2.deactivated).toBe(1);
    expect(fetcher.calls()).toBe(0); // no anchor fetched: stay reuses, gone takes the deactivation path

    const goneAfter2 = await getDrepById(env.DB, gone);
    expect(goneAfter2!.active).toBe(false);
    expect(goneAfter2!.status).toBe('deregistered');
    expect(goneAfter2!.votingPower).toBe('0');
    // Profile preserved for the governance record.
    expect(goneAfter2!.name).toBe('Alice DRep');
    expect(goneAfter2!.imageUrl).toBe('https://example.com/alice.png');
    expect(goneAfter2!.anchorStatus).toBe('ok');
    expect(goneAfter2!.lastSyncedAt).toBe(NOW + 1);

    // The still-registered DRep is untouched.
    expect((await getDrepById(env.DB, stay))!.active).toBe(true);
  });

  it('does not deactivate active rows when the enumeration is empty', async () => {
    const id = 'drep1-dereg-empty';
    const r1 = fakeKoios({ pages: [[listRow(id)]], infoById: new Map([[id, infoRow(id)]]) });
    await syncDreps({ koios: r1.koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW });
    expect((await getDrepById(env.DB, id))!.active).toBe(true);

    // A transient empty drep_list must not be read as "everyone deregistered".
    const r2k = fakeKoios({ pages: [[]], infoById: new Map() });
    const r2 = await syncDreps({ koios: r2k.koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW + 1 });
    expect(r2.deactivated).toBe(0);
    expect((await getDrepById(env.DB, id))!.active).toBe(true);
  });

  it('threads followedDrepIds through to emit a status-change job when a followed DRep deactivates', async () => {
    const stay = 'drep1-dereg-fanout-stay';
    const gone = 'drep1-dereg-fanout-gone';

    // Run 1: both registered and active.
    const r1 = fakeKoios({
      pages: [[listRow(stay), listRow(gone)]],
      infoById: new Map([[stay, anchored(stay)], [gone, anchored(gone)]]),
    });
    await syncDreps({ koios: r1.koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW });

    // Run 2: `gone` deregistered, and it is in the followed set.
    const r2k = fakeKoios({
      pages: [[listRow(stay, true), listRow(gone, false)]],
      infoById: new Map([
        [stay, anchored(stay)],
        [gone, infoRow(gone, { drep_status: 'deregistered', active: false, amount: '0', deposit: null, meta_url: null, meta_hash: null })],
      ]),
    });
    const r2 = await syncDreps({
      koios: r2k.koios,
      db: env.DB,
      fetchImpl: countingProfileFetch().fetchImpl,
      now: NOW + 1,
      followedDrepIds: new Set([gone]),
    });
    expect(r2.deactivated).toBe(1);

    const jobs = await env.DB
      .prepare('SELECT event_type, subject_id FROM notification_fanout_jobs WHERE subject_id = ?')
      .bind(gone)
      .all<{ event_type: string; subject_id: string }>();
    expect(jobs.results).toHaveLength(1);
    expect(jobs.results[0].event_type).toBe('delegator_drep_status_changed');
  });

  it('leaves a DRep that re-registered between enumeration and lookup for the next sync', async () => {
    const a = 'drep1-dereg-race-a';
    const b = 'drep1-dereg-race-b';
    const r1 = fakeKoios({ pages: [[listRow(a), listRow(b)]], infoById: new Map([[a, infoRow(a)], [b, infoRow(b)]]) });
    await syncDreps({ koios: r1.koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW });

    // `b` dropped from the registered enumeration, but drep_info still reports it
    // active (a re-registration landed in between). It must NOT be deactivated.
    const r2k = fakeKoios({
      pages: [[listRow(a, true), listRow(b, false)]],
      infoById: new Map([[a, infoRow(a)], [b, infoRow(b, { active: true })]]),
    });
    const res = await syncDreps({ koios: r2k.koios, db: env.DB, fetchImpl: countingProfileFetch().fetchImpl, now: NOW + 1 });
    expect(res.deactivated).toBe(0);
    expect((await getDrepById(env.DB, b))!.active).toBe(true);
  });
});

describe('stored-avatar preservation', () => {
  it('a re-sync write preserves the avatar-store-owned columns', async () => {
    const drepId = 'drep1avatarkeep';
    const anchorHash = 'f'.repeat(64);
    // Seed: a synced row with a stored avatar and an ok anchor.
    await upsertDrep(env.DB, {
      drepId,
      hex: 'cafe01',
      hasScript: false,
      status: 'registered',
      active: true,
      deposit: '500000000',
      votingPower: '1000',
      expiresEpochNo: 600,
      name: 'Avatar Keeper',
      bio: null,
      imageUrl: 'https://example.com/keep.png',
      imageContentHash: 'b'.repeat(64),
      imageStoredUrl: 'https://example.com/keep.png',
      imageFetchFailedAt: 1234,
      links: null,
      motivations: null,
      qualifications: null,
      paymentAddress: null,
      doNotList: false,
      anchorUrl: 'https://example.com/keep.json',
      anchorHash,
      anchorStatus: 'ok',
      // Current version so the sync takes the no-fetch reuse path (the point of this test).
      profileExtractVersion: PROFILE_EXTRACT_VERSION,
      lastSyncedAt: 1,
      createdAt: 1,
    });

    // Fake koios: same DRep, unchanged anchor (reuse path; syncDreps gets no
    // fetchImpl, so an accidental anchor fetch would throw and fail the test),
    // but a changed voting power so hasChanged forces a write.
    const seedListRow: DrepListRow = { drep_id: drepId, hex: 'cafe01', has_script: false, registered: true };
    const seedInfoRow: DrepInfoRow = {
      drep_id: drepId,
      hex: 'cafe01',
      has_script: false,
      drep_status: 'registered',
      deposit: '500000000',
      active: true,
      expires_epoch_no: 600,
      amount: '2000',
      meta_url: 'https://example.com/keep.json',
      meta_hash: anchorHash,
    };
    const koios = {
      drepList: async () => [seedListRow],
      drepInfoBatch: async () => [seedInfoRow],
    };

    const result = await syncDreps({ koios, db: env.DB, now: 2_000 });
    expect(result.updated).toBe(1);

    const after = await getDrepById(env.DB, drepId);
    expect(after!.votingPower).toBe('2000');
    expect(after!.imageContentHash).toBe('b'.repeat(64));
    expect(after!.imageStoredUrl).toBe('https://example.com/keep.png');
    expect(after!.imageFetchFailedAt).toBe(1234);
  });

  it('ingests an inline data: avatar into R2 and sets image_content_hash', async () => {
    const id = 'drep1-inline-avatar';
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
    const uri = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;
    const doc = { '@context': {}, hashAlgorithm: 'blake2b-256', body: { givenName: 'Pixel', image: uri } };
    const json = JSON.stringify(doc);
    const hash = bytesToHex(blake2b256(new TextEncoder().encode(json)));
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { meta_url: 'https://example.com/p.json', meta_hash: hash })]]),
    });
    const fetchImpl: typeof fetch = async () => jsonResponse(json);

    await syncDreps({ koios, db: env.DB, fetchImpl, now: NOW, bucket: env.AVATARS as R2Bucket });

    const expected = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', png)));
    const stored = await getDrepById(env.DB, id);
    // The inline image is stored in R2 and addressed by content hash; no URL.
    expect(stored!.imageUrl).toBeNull();
    expect(stored!.imageContentHash).toBe(expected);
    expect(await (env.AVATARS as R2Bucket).get(`avatars/${expected}`)).not.toBeNull();
  });

  it('falls back to no stored avatar for an inline data: image when no bucket is wired', async () => {
    const id = 'drep1-inline-no-bucket';
    const uri = `data:image/png;base64,${btoa('\x89PNGabcd')}`;
    const doc = { '@context': {}, hashAlgorithm: 'blake2b-256', body: { givenName: 'NoBucket', image: uri } };
    const json = JSON.stringify(doc);
    const hash = bytesToHex(blake2b256(new TextEncoder().encode(json)));
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { meta_url: 'https://example.com/p.json', meta_hash: hash })]]),
    });

    await syncDreps({ koios, db: env.DB, fetchImpl: (async () => jsonResponse(json)) as typeof fetch, now: NOW });

    const stored = await getDrepById(env.DB, id);
    expect(stored!.imageUrl).toBeNull();
    expect(stored!.imageContentHash).toBeNull();
  });
});

// Anchor URLs minted by our own registration flow point back at this site
// (<origin>/drep/<hash>.json). Fetching them over HTTP from the sync Worker is a
// same-zone subrequest that Cloudflare's loop prevention routes to a blackhole
// origin (504 after a long timeout), so the sync must read the stored body from
// the drep_metadata table instead and never issue the HTTP fetch.
describe('self-hosted anchors', () => {
  it('resolves a dreptalk.com-hosted anchor from D1 without an HTTP fetch', async () => {
    const id = 'drep1-selfhosted-main';
    // Host the document the way the registration flow does.
    await putDrepMetadata(env.DB, { drepId: id, body: profileJson, hash: profileHash, name: 'Alice DRep', createdAt: 1000 });
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([
        [id, infoRow(id, { meta_url: `https://dreptalk.com/drep/${profileHash}.json`, meta_hash: profileHash })],
      ]),
    });
    const fetcher = countingProfileFetch();

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    expect(fetcher.calls()).toBe(0); // the HTTP fetch would blackhole; must not happen
    expect(result).toMatchObject({ total: 1, updated: 1, failed: 0 });
    const stored = await getDrepById(env.DB, id);
    expect(stored!.anchorStatus).toBe('ok');
    expect(stored!.name).toBe('Alice DRep');
    expect(stored!.bio).toBe('Champion of the test suite.');
    expect(stored!.profileExtractVersion).toBe(PROFILE_EXTRACT_VERSION);
  });

  // The subdomain (preprod.dreptalk.com) and lookalike-host axes are pinned by
  // the pure URL tests in selfHostedDocs.test.ts; no duplicate integration runs.

  it('records fetch-failed when the self-hosted document is missing from D1', async () => {
    // No putDrepMetadata: the row the URL points at does not exist, exactly what
    // the HTTP route's 404 would mean.
    const id = 'drep1-selfhosted-missing';
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([
        [id, infoRow(id, { meta_url: `https://dreptalk.com/drep/${profileHash}.json`, meta_hash: profileHash })],
      ]),
    });
    const fetcher = countingProfileFetch();

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    expect(fetcher.calls()).toBe(0);
    expect(result.failed).toBe(0); // tolerated like any non-ok anchor, not a crash
    const stored = await getDrepById(env.DB, id);
    expect(stored!.anchorStatus).toBe('fetch-failed');
    expect(stored!.name).toBeNull();
  });

  it('records hash-mismatch when the stored body does not hash to the on-chain anchor', async () => {
    // The URL filename addresses a stored row, but the on-chain meta_hash is a
    // different value: the same integrity pipeline as a fetched doc must reject it.
    const id = 'drep1-selfhosted-mismatch';
    await putDrepMetadata(env.DB, { drepId: id, body: profileJson, hash: profileHash, name: 'Alice DRep', createdAt: 1000 });
    const otherHash = 'e'.repeat(64);
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([
        [id, infoRow(id, { meta_url: `https://dreptalk.com/drep/${profileHash}.json`, meta_hash: otherHash })],
      ]),
    });
    const fetcher = countingProfileFetch();

    await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    expect(fetcher.calls()).toBe(0);
    const stored = await getDrepById(env.DB, id);
    expect(stored!.anchorStatus).toBe('hash-mismatch');
    expect(stored!.name).toBeNull();
  });

  it('still fetches foreign URLs whose path merely looks like a hosted document', async () => {
    const id = 'drep1-foreign-lookalike';
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([
        [id, infoRow(id, { meta_url: `https://example.com/drep/${profileHash}.json`, meta_hash: profileHash })],
      ]),
    });
    const fetcher = countingProfileFetch();

    await syncDreps({ koios, db: env.DB, fetchImpl: fetcher.fetchImpl, now: NOW });

    expect(fetcher.calls()).toBe(1); // foreign host: normal HTTP path, unchanged
    const stored = await getDrepById(env.DB, id);
    expect(stored!.anchorStatus).toBe('ok');
    expect(stored!.name).toBe('Alice DRep');
  });
});

// The delegator headcount now rides along on the same /drep_info row the chain
// sync already fetches (Koios's live_delegator_count), so there is no separate
// delegator-count phase: the count and its synced_at land with the profile write.
describe('syncDreps delegator counts', () => {
  const noFetch = (async () => jsonResponse('[]')) as typeof fetch;

  it('stores live_delegator_count and stamps delegator_count_synced_at', async () => {
    const id = 'drep1-delegators';
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { live_delegator_count: 42 })]]),
    });

    await syncDreps({ koios, db: env.DB, fetchImpl: noFetch, now: NOW });

    const stored = await getDrepById(env.DB, id);
    expect(stored!.delegatorCount).toBe(42);
    expect(stored!.delegatorCountSyncedAt).toBe(NOW);
  });

  it('stores a zero count (0 is a real value, not "unknown")', async () => {
    const id = 'drep1-zero-delegators';
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { live_delegator_count: 0 })]]),
    });

    await syncDreps({ koios, db: env.DB, fetchImpl: noFetch, now: NOW });

    const stored = await getDrepById(env.DB, id);
    expect(stored!.delegatorCount).toBe(0);
    expect(stored!.delegatorCountSyncedAt).toBe(NOW);
  });

  it('leaves the stored count untouched when Koios omits the field', async () => {
    const id = 'drep1-missing-count';
    // First run: Koios reports a count.
    const withCount = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { live_delegator_count: 7 })]]),
    });
    await syncDreps({ koios: withCount.koios, db: env.DB, fetchImpl: noFetch, now: NOW });

    // Second run: the field is absent (undefined) -> count is unknown, keep the
    // stored value and its earlier timestamp rather than clobbering with null.
    const info = infoRow(id, { amount: '2000000000' });
    delete (info as { live_delegator_count?: number | null }).live_delegator_count;
    const without = fakeKoios({ pages: [[listRow(id)]], infoById: new Map([[id, info]]) });
    await syncDreps({ koios: without.koios, db: env.DB, fetchImpl: noFetch, now: NOW + 60_000 });

    const stored = await getDrepById(env.DB, id);
    expect(stored!.delegatorCount).toBe(7);
    expect(stored!.delegatorCountSyncedAt).toBe(NOW);
    // The unrelated voting-power change still persisted.
    expect(stored!.votingPower).toBe('2000000000');
  });

  it('rewrites a row when only the delegator count changed', async () => {
    const id = 'drep1-count-change';
    const first = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { live_delegator_count: 3 })]]),
    });
    await syncDreps({ koios: first.koios, db: env.DB, fetchImpl: noFetch, now: NOW });

    const second = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { live_delegator_count: 5 })]]),
    });
    const r = await syncDreps({ koios: second.koios, db: env.DB, fetchImpl: noFetch, now: NOW + 60_000 });

    expect(r).toMatchObject({ updated: 1, skipped: 0 });
    const stored = await getDrepById(env.DB, id);
    expect(stored!.delegatorCount).toBe(5);
    expect(stored!.delegatorCountSyncedAt).toBe(NOW + 60_000);
  });

  it('collects only the counts Koios actually delivered this run', async () => {
    const idWithCount = 'drep1-observed-count';
    const idWithoutCount = 'drep1-observed-missing';
    const infoWithout = infoRow(idWithoutCount);
    delete (infoWithout as { live_delegator_count?: number | null }).live_delegator_count;
    const { koios } = fakeKoios({
      pages: [[listRow(idWithCount), listRow(idWithoutCount)]],
      infoById: new Map([
        [idWithCount, infoRow(idWithCount, { live_delegator_count: 42 })],
        [idWithoutCount, infoWithout],
      ]),
    });

    const result = await syncDreps({ koios, db: env.DB, fetchImpl: noFetch, now: NOW });

    expect(result.observedDelegatorCounts.get(idWithCount)).toBe(42);
    expect(result.observedDelegatorCounts.has(idWithoutCount)).toBe(false);
  });

  it('keeps the special ids in observedDelegatorCounts for the epoch stamp', async () => {
    // drep_always_abstain is a Koios pseudo-drep, not a real registered DRep
    // (see dreps/special.ts), but the epoch stats abstain_delegators column is
    // stamped straight from this map with no filtering. If a future change
    // filters the specials out of observedDelegatorCounts, that column would
    // silently go blank, so this test freezes the current, unfiltered behavior.
    const id = 'drep_always_abstain';
    const { koios } = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { live_delegator_count: 193000 })]]),
    });

    const r = await syncDreps({ koios, db: env.DB, fetchImpl: noFetch, now: NOW });

    expect(r.observedDelegatorCounts.get('drep_always_abstain')).toBe(193000);
  });

  it('observes a count even when the row is unchanged and the write is skipped', async () => {
    const id = 'drep1-observed-unchanged';
    const first = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { live_delegator_count: 7 })]]),
    });
    await syncDreps({ koios: first.koios, db: env.DB, fetchImpl: noFetch, now: NOW });

    // Second run with the identical count: buildRow's output is unchanged, so
    // the write is skipped entirely, but the observation must still be recorded.
    const second = fakeKoios({
      pages: [[listRow(id)]],
      infoById: new Map([[id, infoRow(id, { live_delegator_count: 7 })]]),
    });
    const secondRunResult = await syncDreps({
      koios: second.koios,
      db: env.DB,
      fetchImpl: noFetch,
      now: NOW + 60_000,
    });

    expect(secondRunResult).toMatchObject({ updated: 0, skipped: 1 });
    expect(secondRunResult.observedDelegatorCounts.get(id)).toBe(7);
  });
});
