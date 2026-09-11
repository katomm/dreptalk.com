// Pins the exact hashed CIP-108 bytes to IPFS via Pinata. Uploads a multipart
// File containing the already-hashed UTF-8 buffer verbatim: never re-serialize
// (JSON.stringify would change whitespace/key order and break the on-chain
// anchor hash, which is blake2b-256 of these exact bytes), never use Pinata's
// JSON upload method.
/**
 * What an upload tells us back. `fileId` and `isDuplicate` exist for the
 * garbage collector: it deletes by file id, and it must never treat a file
 * Pinata deduplicated onto an existing upload as one of ours to delete.
 */
export interface UploadResult {
  cid: string;
  size: number;
  /** Pinata's own file id, the handle its delete endpoint takes. */
  fileId: string | null;
  /** True when Pinata matched existing bytes instead of storing new ones. */
  isDuplicate: boolean;
}

export type FileUploader = (file: File, jwt: string, groupId?: string) => Promise<UploadResult>;

const TEXT_ENCODER = new TextEncoder();

// Accepts both CIDv0 (Qm... base58, sha2-256) and CIDv1 (b... base32, e.g.
// bafybei... for dag-pb/raw). Pinata's public gateway returns CIDv1 by default.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

// Every Pinata call this app makes lives in this module: upload, read, delete.
// One place owns the base URLs, the bearer header, the v3 `data` envelope and
// the error shape, and one place enforces the rule that protects the shared
// account (see removeFile). Tests inject fakes at the two seams below and never
// make a real network call.
const FETCH_TIMEOUT_MS = 8_000;
const FILES_API = 'https://api.pinata.cloud/v3/files/public';

/** Pinata with a bound timeout: a hung call must not park a cron phase. */
async function pinataFetch(url: string, jwt: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${jwt}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Talks to Pinata's v3 file upload API. Isolated here so tests inject a fake
// FileUploader and never make a real network call.
const defaultUpload: FileUploader = async (file, jwt, groupId) => {
  const form = new FormData();
  form.append('file', file, file.name);
  // v3 defaults new files to private; a governance anchor must be publicly
  // fetchable via ipfs://, so this is required, not optional.
  form.append('network', 'public');
  // Put the file in our own Pinata group when one is configured. The account is
  // shared with another project, and the group is what later proves a file is
  // ours to delete. Uploading without it is allowed and simply means the file
  // can never be garbage collected, which is the safe direction to fail.
  if (groupId) form.append('group_id', groupId);
  const resp = await pinataFetch('https://uploads.pinata.cloud/v3/files', jwt, {
    method: 'POST',
    body: form,
  });
  if (!resp.ok) {
    throw new Error(`pinata upload failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  }
  const json = (await resp.json()) as {
    data?: { cid?: string; size?: number; id?: string; is_duplicate?: boolean };
  };
  const cid = json.data?.cid;
  const size = json.data?.size;
  if (!cid || typeof size !== 'number') throw new Error('pinata response missing data.cid/data.size');
  return {
    cid,
    size,
    fileId: typeof json.data?.id === 'string' ? json.data.id : null,
    isDuplicate: json.data?.is_duplicate === true,
  };
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
  /** Our Pinata group, when configured. Absent means the file is not collectable. */
  groupId?: string;
  upload?: FileUploader;
}): Promise<{ cid: string; fileId: string | null }> {
  const bytes = TEXT_ENCODER.encode(input.body);
  const file = new File([bytes], `${input.anchorHash}.json`, { type: 'application/ld+json' });
  const upload = input.upload ?? defaultUpload;
  const { cid, size, fileId, isDuplicate } = await upload(file, input.jwt, input.groupId);
  if (size !== bytes.byteLength) throw new Error(`pinata size mismatch: uploaded ${size}, expected ${bytes.byteLength}`);
  if (!CID_RE.test(cid)) throw new Error(`pinata returned an invalid CID: ${cid}`);
  // A duplicate means Pinata matched bytes that were already on the account, so
  // the id it handed back may belong to a file this app never created. Returning
  // null keeps it out of the collector's reach. The anchor still resolves: the
  // CID is the same bytes either way, which is the whole point of content
  // addressing. Same for an upload that produced no id at all.
  return { cid, fileId: isDuplicate ? null : fileId };
}

// ---------------------------------------------------------------------------
// Deleting, for the pin collector
// ---------------------------------------------------------------------------

/**
 * Outcome of asking Pinata to drop a file.
 *
 * `not-ours` is the one that matters. The Pinata account is SHARED with another
 * project, and a scoped API key restricts permissions, not which files those
 * permissions reach, so a token that can delete our files can delete theirs.
 * The only real boundary is the group, which is why removeFile REQUIRES one and
 * checks it itself rather than trusting its caller to have looked.
 */
export type RemoveOutcome = 'removed' | 'already-gone' | 'not-ours';

/** The delete half of the Pinata surface, injectable so tests never hit the network. */
export interface PinataFileRemover {
  /** Drops a file, but only if it is in `requireGroup`. Throws on a transport error. */
  removeFile(fileId: string, requireGroup: string): Promise<RemoveOutcome>;
}

/**
 * The real deleter. Needs the Files permission at Write, which is the same level
 * uploading needs, so this token is not less powerful than the app's: Pinata has
 * no tier that permits creating a file but not deleting one. Keeping it separate
 * is about revoking one without the other, not about capability.
 *
 * There is deliberately NO list operation here or anywhere else: the collector
 * must never enumerate an account it shares, and the absence of the capability
 * is what makes that structural rather than a rule someone has to remember.
 */
export function makePinataRemover(jwt: string): PinataFileRemover {
  return {
    async removeFile(fileId, requireGroup) {
      const path = `${FILES_API}/${encodeURIComponent(fileId)}`;
      const read = await pinataFetch(path, jwt);
      // Already gone is the goal state, not a failure.
      if (read.status === 404) return 'already-gone';
      if (!read.ok) throw new Error(`pinata read failed: ${read.status}`);
      const json = (await read.json()) as { data?: { group_id?: string | null } };
      // The ownership test. It is done here, on every delete, precisely so a
      // second caller cannot skip it by forgetting to look first.
      if ((json.data?.group_id ?? null) !== requireGroup) return 'not-ours';

      const del = await pinataFetch(path, jwt, { method: 'DELETE' });
      if (del.status === 404) return 'already-gone';
      if (!del.ok) throw new Error(`pinata delete failed: ${del.status}`);
      return 'removed';
    },
  };
}
