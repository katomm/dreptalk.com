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
      return { cid: VALID_CID, size: seenBytes.byteLength };
    };
    const res = await pinInfoActionMetadata({ body, anchorHash: 'abc123', jwt: 'jwt', upload });
    expect(res.cid).toBe(VALID_CID);
    expect(seenName).toBe('abc123.json');
    // Byte-identical: no re-stringify, no whitespace or key-order drift.
    expect(new TextDecoder().decode(seenBytes!)).toBe(body);
  });

  it('throws when the uploaded size does not match the input bytes', async () => {
    const upload = async () => ({ cid: VALID_CID, size: 999 });
    await expect(pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', upload })).rejects.toThrow();
  });

  it('throws when the returned CID has an invalid format', async () => {
    const upload = async (file: File) => ({ cid: 'not-a-cid', size: file.size });
    await expect(pinInfoActionMetadata({ body: '{}', anchorHash: 'h', jwt: 'j', upload })).rejects.toThrow();
  });

  it('does not go through JSON.stringify again (preserves exotic bytes verbatim)', async () => {
    // A body that already contains escaped unicode and odd spacing; if the
    // adapter ever re-serialized this, whitespace/escaping would change.
    const body = '{"title":"caf\\u00e9","list":[1,  2,3]}';
    let seenBytes: Uint8Array | null = null;
    const upload = async (file: File) => {
      seenBytes = new Uint8Array(await file.arrayBuffer());
      return { cid: VALID_CID, size: seenBytes.byteLength };
    };
    await pinInfoActionMetadata({ body, anchorHash: 'deadbeef', jwt: 'j', upload });
    expect(new TextDecoder().decode(seenBytes!)).toBe(body);
  });
});
