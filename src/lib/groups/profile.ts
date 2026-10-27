// Group profiles: the CIP-100 document a group's anchor points to, fetched with the shared anchor
// fetcher, and the optional website proof through a well-known file.
import type { CardanoNetwork } from '../config/network.js';
import { delayProfile, hasProfileFor, type PaymentAddress, profilesToFetch, setWebsiteCheck, upsertProfile, websitesToCheck } from '../db/drepGroups.js';
import { ANCHOR_FETCH_TIMEOUT_MS, type DedicatedGateway, fetchAnchorDoc, isHttpUrl, jsonLdValue } from '../governance/metadata.js';
import { readBodyLimited } from '../http/bodyLimit.js';
import { sanitizeExternalText } from '../validation/input.js';
import { WELL_KNOWN_MAX_BYTES } from './constants.js';

export { PROFILE_RETRY_MS, WEBSITE_RECHECK_MS, WELL_KNOWN_MAX_BYTES } from './constants.js';

const LIMITS = { name: 120, description: 2000, url: 500 };
const MAX_ADDRESSES = 10;

interface GroupProfileFields {
  name: string | null;
  description: string | null;
  website: string | null;
  image: string | null;
  charter: string | null;
  paymentAddresses: PaymentAddress[];
}

function text(v: unknown, max: number): string | null {
  const x = jsonLdValue(v);
  if (typeof x !== 'string') return null;
  // Control characters out, then capped by code points so a surrogate pair is never split.
  const t = Array.from(sanitizeExternalText(x, Number.POSITIVE_INFINITY)).slice(0, max).join('');
  return t.length === 0 ? null : t;
}

// Only http(s) values become links on the page.
function link(v: unknown): string | null {
  const t = text(v, LIMITS.url);
  return t && isHttpUrl(t) ? t : null;
}

export function extractGroupProfile(doc: unknown): GroupProfileFields {
  const body = doc && typeof doc === 'object' ? (doc as Record<string, unknown>).body : null;
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const list = jsonLdValue(b.paymentAddresses);
  const paymentAddresses = (Array.isArray(list) ? list : [])
    .flatMap((e): PaymentAddress[] => {
      if (!e || typeof e !== 'object') return [];
      const o = e as Record<string, unknown>;
      const address = text(o.address, LIMITS.url);
      if (!address) return [];
      const purpose = text(o.purpose, LIMITS.name) ?? undefined;
      const script = text(o.treasuryScript, 56);
      const treasuryScript = script && /^[0-9a-f]{56}$/.test(script) ? script : undefined;
      return [{ address, ...(purpose ? { purpose } : {}), ...(treasuryScript ? { treasuryScript } : {}) }];
    })
    .slice(0, MAX_ADDRESSES);
  return {
    name: text(b.name, LIMITS.name),
    description: text(b.description, LIMITS.description),
    website: link(b.website),
    image: link(b.image),
    charter: link(b.charter),
    paymentAddresses,
  };
}

/** Fetches the profiles that are due. `limit` is the phase's allowance of groups. */
export async function refreshGroupProfiles(deps: {
  db: D1Database;
  lease: string;
  fetchImpl: typeof fetch;
  gateway?: DedicatedGateway | null;
  now: number;
  limit: number;
}): Promise<{ fetched: number; failed: number }> {
  let fetched = 0;
  let failed = 0;
  for (const p of await profilesToFetch(deps.db, deps.now, deps.limit, deps.lease)) {
    const r = await fetchAnchorDoc(p.url, p.dataHash, { fetchImpl: deps.fetchImpl, db: deps.db, gateway: deps.gateway ?? null });
    // A transport failure keeps a profile already stored for this document and only delays the next try.
    const transient = r.status === 'fetch-failed' || r.status === 'rate-limited';
    if (transient && (await hasProfileFor(deps.db, p.groupId, p.dataHash))) {
      await delayProfile(deps.db, deps.lease, p.groupId, p.url, p.dataHash, deps.now);
      failed++;
      continue;
    }
    const f = r.status === 'ok' ? extractGroupProfile(r.doc) : null;
    await upsertProfile(
      deps.db,
      deps.lease,
      {
        groupId: p.groupId,
        profileUrl: p.url,
        dataHash: p.dataHash,
        status: r.status,
        name: f?.name ?? null,
        description: f?.description ?? null,
        website: f?.website ?? null,
        image: f?.image ?? null,
        charter: f?.charter ?? null,
        paymentAddresses: f?.paymentAddresses ?? [],
        fetchedAt: deps.now,
        websiteVerifiedAt: null,
        websiteCheckedAt: null,
      },
      deps.now,
    );
    if (r.status === 'ok') fetched++;
    else failed++;
  }
  return { fetched, failed };
}

async function wellKnownLists(website: string, network: CardanoNetwork, groupId: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  const url = new URL(website);
  if (url.protocol !== 'https:') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url.origin}/.well-known/cardano-drep-groups.json`, { redirect: 'manual', signal: controller.signal });
    if (res.status !== 200) {
      await res.body?.cancel();
      return false;
    }
    const read = await readBodyLimited(res.body, WELL_KNOWN_MAX_BYTES);
    if (!read.ok) return false;
    const json = JSON.parse(new TextDecoder().decode(read.bytes)) as Record<string, unknown>;
    const ids = json[network];
    return Array.isArray(ids) && ids.includes(groupId);
  } finally {
    clearTimeout(timer);
  }
}

/** Checks the websites that are due. `limit` is the phase's allowance of groups. */
export async function verifyGroupWebsites(deps: {
  db: D1Database;
  lease: string;
  fetchImpl: typeof fetch;
  now: number;
  network: CardanoNetwork;
  limit: number;
  timeoutMs?: number;
}): Promise<{ checked: number; verified: number }> {
  let checked = 0;
  let verified = 0;
  for (const w of await websitesToCheck(deps.db, deps.now, deps.limit, deps.lease)) {
    let ok = false;
    try {
      ok = await wellKnownLists(w.website, deps.network, w.groupId, deps.fetchImpl, deps.timeoutMs ?? ANCHOR_FETCH_TIMEOUT_MS);
    } catch {
      ok = false;
    }
    await setWebsiteCheck(deps.db, deps.lease, w.groupId, ok, deps.now);
    checked++;
    if (ok) verified++;
  }
  return { checked, verified };
}
