// pinInfoActionMetadata must upload the exact hashed bytes unmodified: no
// re-serialization, no re-encoding. These tests inject a fake uploader so
// they never touch the network.
import { describe, expect, it } from 'vitest';
import { pinInfoActionMetadata } from './pinata.js';

const VALID_CID = 'bafybeihgxdzljxb26q6nf3r3eifqeedsvt2eubqtskghpme66cgjyw4fra';

describe('pinInfoActionMetadata', () => {
  it('uploads the exact body bytes, unmodified', async () => {
    const body = JSON.stringify({ a: 1, nested: { b: '  spaces  ' } });
    let seenBytes: Uint8Array | null = null;
    let seenName = '';
    const upload = async (file: File, _jwt: string) => {
      seenName = file.name;
      seenBytes = new Uint8Array(await file.arrayBuffer());
      return { cid: VALID_CID, size: seenBytes.byteLength, fileId: 'file-1', isDuplicate: false };
    };
    const res = await pinInfoActionMetadata({ body, anchorHash: 'abc123', jwt: 'jwt', upload });
    expect(res.cid).toBe(VALID_CID);
    expect(seenName).toBe('abc123.json');
    // Byte-identical: no re-stringify, no whitespace or key-order drift.
    expect(new TextDecoder().decode(seenBytes!)).toBe(body);
  });

  it('throws when the uploaded size does not match the input bytes', async () => {
    const upload = async () => ({ cid: VALID_CID, size: 999, fileId: 'f', isDuplicate: false });
    await expect(pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', upload })).rejects.toThrow();
  });

  it('throws when the returned CID has an invalid format', async () => {
    const upload = async (file: File) => ({ cid: 'not-a-cid', size: file.size, fileId: 'f', isDuplicate: false });
    await expect(pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', upload })).rejects.toThrow();
  });

  it('returns the file id so the collector has a handle to delete by', async () => {
    const upload = async (file: File) => ({ cid: VALID_CID, size: file.size, fileId: 'pin-42', isDuplicate: false });
    const res = await pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', upload });
    expect(res.fileId).toBe('pin-42');
  });

  // The Pinata account is shared with another project. A duplicate means Pinata
  // matched bytes already on the account, so the id may belong to a file this
  // app never created. Dropping it is what keeps the collector off it.
  it('drops the file id when Pinata reports a duplicate', async () => {
    const upload = async (file: File) => ({ cid: VALID_CID, size: file.size, fileId: 'someone-elses', isDuplicate: true });
    const res = await pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', upload });
    expect(res.cid).toBe(VALID_CID);
    expect(res.fileId).toBeNull();
  });

  it('drops the file id when the response carried none', async () => {
    const upload = async (file: File) => ({ cid: VALID_CID, size: file.size, fileId: null, isDuplicate: false });
    const res = await pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', upload });
    expect(res.fileId).toBeNull();
  });

  it('passes the configured group through to the uploader, and omits it when unset', async () => {
    const seen: (string | undefined)[] = [];
    const upload = async (file: File, _jwt: string, groupId?: string) => {
      seen.push(groupId);
      return { cid: VALID_CID, size: file.size, fileId: 'f', isDuplicate: false };
    };
    await pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', groupId: 'grp-7', upload });
    await pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', upload });
    expect(seen).toEqual(['grp-7', undefined]);
  });

  it('does not go through JSON.stringify again (preserves exotic bytes verbatim)', async () => {
    // A body that already contains escaped unicode and odd spacing; if the
    // adapter ever re-serialized this, whitespace/escaping would change.
    const body = '{"title":"caf\\u00e9","list":[1,  2,3]}';
    let seenBytes: Uint8Array | null = null;
    const upload = async (file: File) => {
      seenBytes = new Uint8Array(await file.arrayBuffer());
      return { cid: VALID_CID, size: seenBytes.byteLength, fileId: 'f', isDuplicate: false };
    };
    await pinInfoActionMetadata({ body, anchorHash: 'deadbeef', jwt: 'j', upload });
    expect(new TextDecoder().decode(seenBytes!)).toBe(body);
  });
});
