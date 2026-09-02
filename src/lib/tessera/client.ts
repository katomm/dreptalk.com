import { z } from 'zod';

// HTTP client for the Tessera serving backend (CIP-179 surveys). Tessera owns
// the protocol behind this API; DRepTalk mirrors its answers into D1 the way it
// mirrors Koios, so this client decodes envelopes only. Survey records,
// responses and cancellations stay wire-form `unknown` here — the cip-179
// package's `fromJsonSafe` is the one place they are parsed, and duplicating
// its schema in zod would be a second CIP-179 implementation waiting to drift.
//
// The client is called from gov-sync only. No page request and no browser code
// may reach Tessera: SSR reads D1, and the CSP's connect-src blocks the backend
// origin. SURVEY_KEY_RE below is the exception the routes do import — the key
// shape is a contract, not a call.

export interface TesseraClientOptions {
  /** Backend origin (TESSERA_BACKEND_URL), with or without a trailing slash. */
  baseUrl: string;
  /**
   * Network this deployment runs on (resolved CARDANO_NETWORK). The client
   * checks it against the backend's /health before the first data request and
   * refuses to serve from a backend indexing a different chain — a misconfigured
   * URL would otherwise mirror preview surveys into the preprod database.
   */
  network: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Any unexpected non-2xx Tessera response. */
export class TesseraHttpError extends Error {
  constructor(public readonly status: number) {
    super(`tessera request failed: ${status}`);
    this.name = 'TesseraHttpError';
  }
}

/** The backend serves a different Cardano network than this deployment. */
export class TesseraNetworkMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`tessera backend serves network "${actual}", expected "${expected}"`);
    this.name = 'TesseraNetworkMismatchError';
  }
}

/**
 * Result of a snapshot-backed route. `ready: false` is the backend's
 * `503 snapshot not ready` (a fresh deployment that has not completed its first
 * refresh): a normal transient state, so the sync skips the run instead of
 * recording an error.
 */
export type SnapshotResult<T> = { ready: true; value: T } | { ready: false };

/** Server-side page ceiling for `/api/surveys` — both the list page and `refs=`. */
export const MAX_REFS_PER_CALL = 200;

/** Canonical survey key: `<txHashHex>:<index>`, index without leading zeros.
 * The contract with Tessera, which keys every survey by this exact string and
 * rejects any other spelling — so the routes and the record API validate a ref
 * against this one shape rather than each carrying a copy of it. */
export const SURVEY_KEY_RE = /^[0-9a-f]{64}:(0|[1-9][0-9]*)$/;

const healthSchema = z.object({ ok: z.boolean(), network: z.string() });

export type TesseraHealth = z.infer<typeof healthSchema>;

// Every field is a plain number; Tessera serves the tip unwrapped (no
// json-safe encoding), so it parses directly.
const tipSchema = z
  .object({
    epoch: z.number(),
    slot: z.number(),
    time: z.number(),
    epochSlot: z.number(),
    govActionLifetime: z.number(),
  })
  .passthrough();

export type TesseraTip = z.infer<typeof tipSchema>;

// A governance action advertising a survey (CIP-179 linkage). Tessera has
// already validated the link, epoch-alignment included; DRepTalk re-checks
// nothing and only joins actionId against its own governance_actions.
const govLinkSchema = z
  .object({
    surveyKey: z.string(),
    actionId: z.string(),
    endEpoch: z.number(),
    title: z.string().nullable(),
  })
  .passthrough();

export type TesseraGovLink = z.infer<typeof govLinkSchema>;

// A survey decided for good: no later snapshot changes it, so the sync freezes
// the row and stops refreshing it. `finalized` and `cancelled` also carry the
// tally artifact hash on the wire, but this mirror shows participation, never
// a result — only `state` is pinned and the hash passes through unread.
const finalStateEntrySchema = z
  .object({ state: z.enum(['finalized', 'cancelled', 'untalliable']) })
  .passthrough();

// The shared body of both /api/surveys selections (a filtered page, or the
// refs the caller names). `incomplete` set means the backend could not index
// every matching record, so absence from `surveys` proves nothing — the sync's
// rollback rule keys on it.
const surveySetSchema = z
  .object({
    surveys: z.array(z.unknown()),
    cancellations: z.array(z.unknown()),
    govLinks: z.array(govLinkSchema),
    tip: tipSchema,
    responseCounts: z.record(z.string(), z.number()),
    finalState: z.record(z.string(), finalStateEntrySchema),
    incomplete: z.boolean().optional(),
    fetchedAt: z.number(),
  })
  .passthrough();

export type SurveySet = z.infer<typeof surveySetSchema>;

const listCountsSchema = z
  .object({
    all: z.number(),
    linked: z.number(),
    active: z.number(),
    sealed: z.number(),
    public: z.number(),
    mine: z.number(),
  })
  .passthrough();

// The paged list adds global per-filter counts (over the whole set, not the
// page — `counts.linked` sizes the linked universe for pass 1's walk decision)
// and keyset paging. `resync` flags a cursor minted against an older snapshot.
const surveyPageSchema = surveySetSchema.extend({
  counts: listCountsSchema,
  nextCursor: z.string().nullable(),
  resync: z.boolean().optional(),
});

export type SurveyPage = z.infer<typeof surveyPageSchema>;

// One survey's bundle: the full response set (paged, 200 per page, server-side
// fixed) plus the credential-proof verdicts validation has decided. A response
// key absent from `verdicts` is *pending*, never failed.
const surveyBundleSchema = z
  .object({
    survey: z.unknown(),
    responses: z.array(z.unknown()),
    cancellations: z.array(z.unknown()),
    govLinks: z.array(govLinkSchema),
    tip: tipSchema,
    verdicts: z.record(z.string(), z.boolean()),
    nextCursor: z.string().nullable(),
    resync: z.boolean().optional(),
    fetchedAt: z.number(),
  })
  .passthrough();

export type SurveyBundlePage = z.infer<typeof surveyBundleSchema>;

// The responses one transaction carried. Settling on the exact transaction is
// the point: /api/responded cannot tell a replacement from the response it
// superseded.
const txResponseSchema = z
  .object({
    surveyKey: z.string(),
    responseIndex: z.number(),
    role: z.number(),
    credential: z.string(),
    slot: z.number(),
  })
  .passthrough();

const txResponsesSchema = z.object({ responses: z.array(txResponseSchema) }).passthrough();

export type TxResponse = z.infer<typeof txResponseSchema>;

export interface SurveyListParams {
  filter?: 'all' | 'linked' | 'active' | 'sealed' | 'public';
  cursor?: string;
  limit?: number;
}

/** A 503 with a non-JSON body is a gateway page, not the backend's not-ready answer. */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createTesseraClient(opts: TesseraClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  // The body is read inside the timed window: `fetch` resolves at the headers,
  // and a body that stalls with nothing armed parks this phase and every phase
  // behind it until the platform kills the invocation.
  async function request(path: string): Promise<{ status: number; ok: boolean; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      return { status: res.status, ok: res.ok, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function health(): Promise<TesseraHealth> {
    const res = await request('/health');
    if (!res.ok) throw new TesseraHttpError(res.status);
    return healthSchema.parse(JSON.parse(res.text));
  }

  // One health check per client (one per cron run): the guard promise is
  // shared so concurrent callers trigger a single request, and a *failed*
  // check evicts itself so a transient health error is not cached for the
  // client's lifetime. A mismatch keeps rejecting — the wrong backend does
  // not become the right one mid-run.
  let guard: Promise<void> | null = null;
  function ensureNetwork(): Promise<void> {
    if (!guard) {
      const p = health().then(h => {
        if (h.network !== opts.network) {
          throw new TesseraNetworkMismatchError(opts.network, h.network);
        }
      });
      guard = p;
      p.catch(err => {
        if (guard === p && !(err instanceof TesseraNetworkMismatchError)) guard = null;
      });
    }
    return guard;
  }

  // Snapshot-backed request: network-guarded, and the backend's
  // `503 snapshot not ready` becomes a ready:false result instead of an error.
  // Any other 503 (a gateway, an outage) still throws — only the body the
  // backend actually sends for "no snapshot yet" is treated as benign.
  async function snapshotRequest<T>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<SnapshotResult<T>> {
    await ensureNetwork();
    const res = await request(path);
    if (res.status === 503) {
      const body = parseJsonOrNull(res.text);
      if (
        typeof body === 'object' &&
        body !== null &&
        (body as { error?: unknown }).error === 'snapshot not ready'
      ) {
        return { ready: false };
      }
      throw new TesseraHttpError(503);
    }
    if (!res.ok) throw new TesseraHttpError(res.status);
    return { ready: true, value: schema.parse(JSON.parse(res.text)) };
  }

  return {
    health,

    async surveyList(params: SurveyListParams = {}): Promise<SnapshotResult<SurveyPage>> {
      const q = new URLSearchParams();
      if (params.filter) q.set('filter', params.filter);
      if (params.cursor) q.set('cursor', params.cursor);
      if (params.limit !== undefined) q.set('limit', String(params.limit));
      const qs = q.toString();
      return snapshotRequest(`/api/surveys${qs ? `?${qs}` : ''}`, surveyPageSchema);
    },

    // The rows for the refs named, no paging or counts. A ref absent from a
    // complete answer names a rolled-back survey — the caller's signal, so the
    // key list must be exact: malformed or oversized input fails here rather
    // than as a server 400 that would read like an outage.
    async surveysByRefs(keys: readonly string[]): Promise<SnapshotResult<SurveySet>> {
      if (keys.length === 0 || keys.length > MAX_REFS_PER_CALL) {
        throw new RangeError(
          `surveysByRefs takes 1..${MAX_REFS_PER_CALL} keys, got ${keys.length}`,
        );
      }
      const bad = keys.find(k => !SURVEY_KEY_RE.test(k));
      if (bad !== undefined) throw new RangeError(`malformed survey key: ${bad}`);
      return snapshotRequest(`/api/surveys?refs=${keys.join(',')}`, surveySetSchema);
    },

    // One page of a survey's bundle (the server fixes the page size at 200
    // responses). The audit pass pages by `nextCursor` and restarts on
    // `resync`: a bundle is a tally input, and a response crossing a snapshot
    // boundary between pages would silently change the count.
    async surveyBundle(key: string, cursor?: string): Promise<SnapshotResult<SurveyBundlePage>> {
      if (!SURVEY_KEY_RE.test(key)) throw new RangeError(`malformed survey key: ${key}`);
      const [txHash, index] = key.split(':');
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return snapshotRequest(`/api/surveys/${txHash}/${index}${qs}`, surveyBundleSchema);
    },

    async responsesByTx(txHash: string): Promise<SnapshotResult<TxResponse[]>> {
      if (!/^[0-9a-f]{64}$/.test(txHash)) throw new RangeError(`malformed tx hash: ${txHash}`);
      const result = await snapshotRequest(`/api/responses/${txHash}`, txResponsesSchema);
      return result.ready ? { ready: true, value: result.value.responses } : result;
    },
  };
}

export type TesseraClient = ReturnType<typeof createTesseraClient>;
