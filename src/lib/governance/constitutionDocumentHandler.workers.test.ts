/// <reference types="@cloudflare/workers-types" />
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { blake2b256 } from '../crypto/blake.js';
import { bytesToHex } from '../crypto/hex.js';
import { handleConstitutionDocument, CONSTITUTION_DOCUMENT_MAX_BYTES } from './constitutionDocumentHandler.js';
import { serveGovActionMetadata } from '../db/govActionMetadata.js';
import * as rate from '../rate.js';

const preprod = { network: 'preprod', networkId: 0 } as never; // minimal NetworkConfig stub
const mainnet = { network: 'mainnet', networkId: 1 } as never;
const withJwt = { ...env, PINATA_JWT: 'jwt' } as Cloudflare.Env;
const user = { user: { id: 'u', roles: [] } } as App.Locals;
const CID = 'bafybeihgxdzljxb26q6nf3r3eifqeedsvt2eubqtskghpme66cgjyw4fra';

function req(body: unknown, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
  return new Request('https://dreptalk.com/api/gov-action/document', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const fakeUpload = async (file: File) => ({
  cid: CID,
  size: (await file.arrayBuffer()).byteLength,
  fileId: 'file-1',
  isDuplicate: false,
});

describe('handleConstitutionDocument gate outcomes', () => {
  it('404 on mainnet', async () => {
    const res = await handleConstitutionDocument(
      { request: req({ text: 'x' }), locals: user },
      { network: mainnet, env: withJwt, upload: fakeUpload },
    );
    expect(res.status).toBe(404);
  });

  it('403 cross-origin', async () => {
    const res = await handleConstitutionDocument(
      { request: req({ text: 'x' }, { 'sec-fetch-site': 'cross-site' }), locals: user },
      { network: preprod, env: withJwt, upload: fakeUpload },
    );
    expect(res.status).toBe(403);
  });

  it('401 signed out', async () => {
    const res = await handleConstitutionDocument(
      { request: req({ text: 'x' }), locals: { user: null } as App.Locals },
      { network: preprod, env: withJwt, upload: fakeUpload },
    );
    expect(res.status).toBe(401);
  });

  it('503 missing DB binding', async () => {
    const res = await handleConstitutionDocument(
      { request: req({ text: 'x' }), locals: user },
      { network: preprod, env: { ...withJwt, DB: undefined } as unknown as Cloudflare.Env, upload: fakeUpload },
    );
    expect(res.status).toBe(503);
  });

  it('503 missing rate limiter binding', async () => {
    const res = await handleConstitutionDocument(
      { request: req({ text: 'x' }), locals: user },
      {
        network: preprod,
        env: { ...withJwt, RATE_LIMITER: undefined } as unknown as Cloudflare.Env,
        upload: fakeUpload,
      },
    );
    expect(res.status).toBe(503);
  });

  it('503 missing PINATA_JWT, "ipfs hosting unavailable"', async () => {
    const res = await handleConstitutionDocument(
      { request: req({ text: 'x' }), locals: user },
      { network: preprod, env: { ...env, PINATA_JWT: undefined } as Cloudflare.Env, upload: fakeUpload },
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('ipfs hosting unavailable');
  });

  it('503 when the rate limiter throws', async () => {
    const spy = vi.spyOn(rate, 'checkRate').mockRejectedValueOnce(new Error('DO unavailable'));
    const res = await handleConstitutionDocument(
      { request: req({ text: 'x' }), locals: user },
      { network: preprod, env: withJwt, upload: fakeUpload },
    );
    expect(res.status).toBe(503);
    spy.mockRestore();
  });

  it('429 rate limited', async () => {
    const spy = vi.spyOn(rate, 'checkRate').mockResolvedValueOnce(false);
    const res = await handleConstitutionDocument(
      { request: req({ text: 'x' }), locals: user },
      { network: preprod, env: withJwt, upload: fakeUpload },
    );
    expect(res.status).toBe(429);
    spy.mockRestore();
  });
});

describe('handleConstitutionDocument', () => {
  it('pins and stores, returning an ipfs url and the blake2b-256 hash', async () => {
    const text = '# Constitution\n\nSome text.';
    const res = await handleConstitutionDocument(
      { request: req({ text }), locals: user },
      { network: preprod, env: withJwt, upload: fakeUpload, now: 1_700_000_000_000 },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; hashHex: string };
    expect(json.url).toBe(`ipfs://${CID}`);
    const expectedHash = bytesToHex(blake2b256(new TextEncoder().encode(text)));
    expect(json.hashHex).toBe(expectedHash);
    const row = await serveGovActionMetadata(env.DB, json.hashHex, 1);
    expect(row?.cid).toBe(CID);
    expect(row?.kind).toBe('constitution');
  });

  it('pins exactly new TextEncoder().encode(text), no trailing newline added', async () => {
    const text = 'No trailing newline here';
    let seenBytes: Uint8Array | null = null;
    const capture = async (file: File) => {
      seenBytes = new Uint8Array(await file.arrayBuffer());
      return { cid: CID, size: seenBytes.byteLength, fileId: 'file-2', isDuplicate: false };
    };
    await handleConstitutionDocument(
      { request: req({ text }), locals: user },
      { network: preprod, env: withJwt, upload: capture, now: 1 },
    );
    expect(seenBytes).toEqual(new TextEncoder().encode(text));
  });

  it('rejects a document over 256 KiB with 413', async () => {
    const text = 'a'.repeat(CONSTITUTION_DOCUMENT_MAX_BYTES + 1);
    const res = await handleConstitutionDocument(
      { request: req({ text }), locals: user },
      { network: preprod, env: withJwt, upload: fakeUpload, now: 1 },
    );
    expect(res.status).toBe(413);
  });

  it('accepts a document exactly at the 256 KiB cap', async () => {
    const text = 'a'.repeat(CONSTITUTION_DOCUMENT_MAX_BYTES);
    const res = await handleConstitutionDocument(
      { request: req({ text }), locals: user },
      { network: preprod, env: withJwt, upload: fakeUpload, now: 2 },
    );
    expect(res.status).toBe(200);
  });

  it('reuses an existing row and cid on a repeat submission, without a second pin', async () => {
    const text = 'Reused constitution text';
    let calls = 0;
    const counting = async (file: File) => {
      calls++;
      return { cid: CID, size: (await file.arrayBuffer()).byteLength, fileId: 'file-3', isDuplicate: false };
    };
    const input = { request: req({ text }), locals: user };
    const deps = { network: preprod, env: withJwt, upload: counting, now: 3 };
    const first = await handleConstitutionDocument(input, deps);
    const second = await handleConstitutionDocument(
      { request: req({ text }), locals: user },
      { network: preprod, env: withJwt, upload: counting, now: 4 },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(calls).toBe(1);
  });

  it('rejects a missing text field', async () => {
    const res = await handleConstitutionDocument(
      { request: req({}), locals: user },
      { network: preprod, env: withJwt, upload: fakeUpload },
    );
    expect(res.status).toBe(400);
  });
});
