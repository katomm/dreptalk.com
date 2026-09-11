// Pins the exact hashed CIP-108 bytes to IPFS via Pinata. Uploads a multipart
// File containing the already-hashed UTF-8 buffer verbatim: never re-serialize
// (JSON.stringify would change whitespace/key order and break the on-chain
// anchor hash, which is blake2b-256 of these exact bytes), never use Pinata's
// JSON upload method.
export type FileUploader = (file: File, jwt: string) => Promise<{ cid: string; size: number }>;

const TEXT_ENCODER = new TextEncoder();

// Accepts both CIDv0 (Qm... base58, sha2-256) and CIDv1 (b... base32, e.g.
// bafybei... for dag-pb/raw). Pinata's public gateway returns CIDv1 by default.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

// Talks to Pinata's v3 file upload API. Isolated here so tests inject a fake
// FileUploader and never make a real network call.
const defaultUpload: FileUploader = async (file, jwt) => {
  const form = new FormData();
  form.append('file', file, file.name);
  // v3 defaults new files to private; a governance anchor must be publicly
  // fetchable via ipfs://, so this is required, not optional.
  form.append('network', 'public');
  const resp = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!resp.ok) {
    throw new Error(`pinata upload failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  }
  const json = (await resp.json()) as { data?: { cid?: string; size?: number } };
  const cid = json.data?.cid;
  const size = json.data?.size;
  if (!cid || typeof size !== 'number') throw new Error('pinata response missing data.cid/data.size');
  return { cid, size };
};

/**
 * Uploads the exact hashed CIP-108 body to IPFS and returns its CID.
 * `body` must be the same string that was hashed for the anchor (the caller's
 * blake2b-256 digest); this function uploads it byte-for-byte, unmodified,
 * and verifies the uploaded size matches before trusting the returned CID.
 */
export async function pinInfoActionMetadata(input: {
  body: string;
  anchorHash: string;
  jwt: string;
  upload?: FileUploader;
}): Promise<{ cid: string }> {
  const bytes = TEXT_ENCODER.encode(input.body);
  const file = new File([bytes], `${input.anchorHash}.json`, { type: 'application/ld+json' });
  const upload = input.upload ?? defaultUpload;
  const { cid, size } = await upload(file, input.jwt);
  if (size !== bytes.byteLength) throw new Error(`pinata size mismatch: uploaded ${size}, expected ${bytes.byteLength}`);
  if (!CID_RE.test(cid)) throw new Error(`pinata returned an invalid CID: ${cid}`);
  return { cid };
}
