import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { handleInfoActionMetadata, prepareInfoActionBodyHash } from './infoActionMetadataHandler.js';
import { canonicalBodyHashFor } from './cip108Canonical.js';
import { getGovActionMetadata } from '@/lib/db/govActionMetadata.js';

const body = { title: 'Ping', abstract: 'A', motivation: 'M', rationale: 'R' };
const CID = 'bafybeihgxdzljxb26q6nf3r3eifqeedsvt2eubqtskghpme66cgjyw4fra';
const fakeUpload = async (file: File) => ({ cid: CID, size: (await file.arrayBuffer()).byteLength });

describe('handleInfoActionMetadata', () => {
  it('pins and stores, returning an ipfs anchor', async () => {
    const res = await handleInfoActionMetadata({
      body: { ...body },
      db: env.DB,
      jwt: 'jwt',
      now: 1_700_000_000_000,
      expectedNetworkId: 0,
      upload: fakeUpload,
    });
    expect(res.status).toBe(200);
    const json = res.json as { anchorUrl: string; anchorHash: string };
    expect(json.anchorUrl).toBe(`ipfs://${CID}`);
    expect(json.anchorHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await getGovActionMetadata(env.DB, json.anchorHash))?.cid).toBe(CID);
  });

  it('rejects missing body fields', async () => {
    const res = await handleInfoActionMetadata({
      body: { title: 'x' },
      db: env.DB,
      jwt: 'jwt',
      now: 1,
      expectedNetworkId: 0,
      upload: fakeUpload,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an author with an invalid witness (no re-upload)', async () => {
    let calls = 0;
    const counting = async (file: File) => {
      calls++;
      return { cid: CID, size: (await file.arrayBuffer()).byteLength };
    };
    const res = await handleInfoActionMetadata({
      body: {
        title: 'Auth',
        abstract: 'A',
        motivation: 'M',
        rationale: 'R',
        author: { name: 'Mallory', keyHex: 'aa', signatureHex: 'bb' },
      },
      db: env.DB,
      jwt: 'j',
      now: 1,
      expectedNetworkId: 0,
      upload: counting,
    });
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it('reuses an existing cid without re-uploading', async () => {
    let calls = 0;
    const counting = async (file: File) => {
      calls++;
      return { cid: CID, size: (await file.arrayBuffer()).byteLength };
    };
    const input = {
      body: { title: 'Dedup', abstract: 'A', motivation: 'M', rationale: 'R' },
      db: env.DB,
      jwt: 'j',
      now: 1,
      expectedNetworkId: 0,
      upload: counting,
    };
    await handleInfoActionMetadata(input);
    await handleInfoActionMetadata(input);
    expect(calls).toBe(1);
  });

  it('rejects a reference with an invalid uri', async () => {
    const res = await handleInfoActionMetadata({
      body: { ...body, title: 'RefBadUri', references: [{ label: 'Bad', uri: 'not-a-url' }] },
      db: env.DB,
      jwt: 'jwt',
      now: 1,
      expectedNetworkId: 0,
      upload: fakeUpload,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a reference with an over-long label', async () => {
    const res = await handleInfoActionMetadata({
      body: { ...body, title: 'RefLongLabel', references: [{ label: 'x'.repeat(201), uri: 'https://example.com' }] },
      db: env.DB,
      jwt: 'jwt',
      now: 1,
      expectedNetworkId: 0,
      upload: fakeUpload,
    });
    expect(res.status).toBe(400);
  });

  it('drops a reference entry whose label is empty after sanitization, keeping the doc references-free', async () => {
    let uploadedBody: string | undefined;
    const capturingUpload = async (file: File) => {
      uploadedBody = await file.text();
      return { cid: CID, size: (await file.arrayBuffer()).byteLength };
    };
    const res = await handleInfoActionMetadata({
      body: { ...body, title: 'RefDropped', references: [{ label: ' ', uri: 'https://example.com' }] },
      db: env.DB,
      jwt: 'jwt',
      now: 1,
      expectedNetworkId: 0,
      upload: capturingUpload,
    });
    expect(res.status).toBe(200);
    const doc = JSON.parse(uploadedBody ?? '{}');
    expect(doc.body.references).toBeUndefined();
  });

  it('rejects more than 10 references', async () => {
    const references = Array.from({ length: 11 }, (_, i) => ({ label: `Ref ${i}`, uri: `https://example.com/${i}` }));
    const res = await handleInfoActionMetadata({
      body: { ...body, title: 'RefTooMany', references },
      db: env.DB,
      jwt: 'jwt',
      now: 1,
      expectedNetworkId: 0,
      upload: fakeUpload,
    });
    expect(res.status).toBe(400);
  });

  it('round-trips a valid, trimmed reference into the stored doc with the fixed @type/label/uri shape', async () => {
    let uploadedBody: string | undefined;
    const capturingUpload = async (file: File) => {
      uploadedBody = await file.text();
      return { cid: CID, size: (await file.arrayBuffer()).byteLength };
    };
    const res = await handleInfoActionMetadata({
      body: {
        ...body,
        title: 'RefValid',
        references: [{ label: '  Forum thread  ', uri: 'https://example.com/thread' }],
      },
      db: env.DB,
      jwt: 'jwt',
      now: 1,
      expectedNetworkId: 0,
      upload: capturingUpload,
    });
    expect(res.status).toBe(200);
    const doc = JSON.parse(uploadedBody ?? '{}');
    expect(doc.body.references).toEqual([
      { '@type': 'Other', label: 'Forum thread', uri: 'https://example.com/thread' },
    ]);
  });
});

describe('CIP-179 survey link', () => {
  const TX = 'cd'.repeat(32);

  it('embeds the link and pins a document a CIP-179 reader accepts', async () => {
    let pinned = '';
    const capture = async (file: File) => {
      pinned = await file.text();
      return { cid: CID, size: (await file.arrayBuffer()).byteLength };
    };
    const res = await handleInfoActionMetadata({
      body: { ...body, title: 'Linked', surveyRef: `${TX}:2` },
      db: env.DB, jwt: 'jwt', now: 1, expectedNetworkId: 0, upload: capture,
    });
    expect(res.status).toBe(200);

    const doc = JSON.parse(pinned);
    expect(doc.body.cip179).toEqual({
      specVersion: 5, kind: 'survey-link', surveyTxId: TX, surveyIndex: 2,
    });
    // That a real CIP-179 reader accepts this document is asserted in the node
    // test (cip179Link.test.ts): cip-179/domain cannot be imported at runtime
    // under workerd, only its types.
    expect(doc['@context']).toHaveProperty('CIP179');
  });

  it('accepts a pasted link and normalises it to the ref', async () => {
    let pinned = '';
    const capture = async (file: File) => {
      pinned = await file.text();
      return { cid: CID, size: (await file.arrayBuffer()).byteLength };
    };
    await handleInfoActionMetadata({
      body: { ...body, title: 'Pasted URL', surveyRef: `https://tessera.example/s/${TX.toUpperCase()}:0?x=1` },
      db: env.DB, jwt: 'jwt', now: 1, expectedNetworkId: 0, upload: capture,
    });
    expect(JSON.parse(pinned).body.cip179).toMatchObject({ surveyTxId: TX, surveyIndex: 0 });
  });

  it('rejects a malformed ref before any upload, and says why', async () => {
    let calls = 0;
    const counting = async (file: File) => { calls++; return { cid: CID, size: (await file.arrayBuffer()).byteLength }; };
    const res = await handleInfoActionMetadata({
      body: { ...body, surveyRef: 'not-a-ref' },
      db: env.DB, jwt: 'jwt', now: 1, expectedNetworkId: 0, upload: counting,
    });
    expect(res.status).toBe(400);
    expect(String((res.json as { error: string }).error)).toMatch(/survey reference/i);
    expect(calls).toBe(0);
  });

  it('prepare signs exactly the body finalize anchors', async () => {
    const input = { ...body, title: 'Same body', surveyRef: `${TX}:5` };

    const prep = await prepareInfoActionBodyHash(input);
    expect(prep.status).toBe(200);

    let pinned = '';
    const capture = async (file: File) => {
      pinned = await file.text();
      return { cid: CID, size: (await file.arrayBuffer()).byteLength };
    };
    await handleInfoActionMetadata({ body: input, db: env.DB, jwt: 'jwt', now: 1, expectedNetworkId: 0, upload: capture });

    const anchored = JSON.parse(pinned).body;
    expect(await canonicalBodyHashFor(anchored)).toBe((prep.json as { bodyHash: string }).bodyHash);
  });
});
