import { z } from 'zod';

export interface KoiosClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retry transient failures (5xx / 429 / network / timeout) this many times. Default 0. */
  retries?: number;
  /** Base delay between retries in ms; doubles per attempt (exponential backoff). Default 300. */
  retryDelayMs?: number;
  /** Cap for a single retry delay (covers both the backoff curve and Retry-After). Default 8000. */
  maxRetryDelayMs?: number;
}

/** Error for any non-2xx Koios response; carries the HTTP status for callers. */
export class KoiosHttpError extends Error {
  constructor(
    public readonly status: number,
    /** Parsed Retry-After response header in ms, when the server sent one. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`koios request failed: ${status}`);
    this.name = 'KoiosHttpError';
  }
}

/** Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

// Koios caps the /drep_info POST body. Send sub-batches under that cap; the
// client halves and retries on a 413, so even a lower cap still completes.
const DREP_INFO_MAX = 50;

const tipSchema = z
  .array(
    z.object({
      epoch_no: z.number(),
      block_no: z.number(),
      abs_slot: z.number(),
    }),
  )
  .nonempty();

export type Tip = z.infer<typeof tipSchema>[number];

// DrepInfo schema: matches the real Koios /drep_info response shape.
// Status is the string field drep_status ("registered", "retired", "expired", ...).
// There is no boolean registered field in the real API.
const drepInfoSchema = z
  .object({
    drep_id: z.string(),
    hex: z.string(),
    has_script: z.boolean(),
    drep_status: z.string(),
    deposit: z.string().nullable(),
    active: z.boolean(),
    expires_epoch_no: z.number().nullable(),
  })
  .passthrough();

export type DrepInfo = z.infer<typeof drepInfoSchema>;

// ScriptInfo schema: native scripts carry type "timelock" with the JSON tree in
// `value`; Plutus scripts use type "plutusV1|2|3". Permissive on purpose: the
// caller validates `value` with parseNativeScriptJson and rejects non-native.
const scriptInfoSchema = z
  .object({
    script_hash: z.string(),
    type: z.string(),
    value: z.unknown().nullable(),
  })
  .passthrough();

export type ScriptInfo = z.infer<typeof scriptInfoSchema>;

// AccountInfo schema: tolerate extra fields, nullable delegation/balance fields.
const accountInfoSchema = z.object({
  stake_address: z.string(),
  status: z.string(),
  delegated_pool: z.string().nullable(),
  delegated_drep: z.string().nullable(),
  total_balance: z.string().nullable(),
}).passthrough();

export type AccountInfo = z.infer<typeof accountInfoSchema>;

// Proposal schema: require the three key fields, tolerate extras.
const proposalSchema = z.object({
  proposal_id: z.string(),
  return_address: z.string(),
  proposal_type: z.string(),
}).passthrough();

export type Proposal = z.infer<typeof proposalSchema>;

// DrepListRow schema: minimal fields returned by GET /drep_list.
// The registered field indicates whether the DRep has an active registration.
const drepListRowSchema = z
  .object({
    drep_id: z.string(),
    hex: z.string(),
    has_script: z.boolean(),
    registered: z.boolean(),
  })
  .passthrough();

export type DrepListRow = z.infer<typeof drepListRowSchema>;

// DrepInfoRow schema: full shape returned by POST /drep_info (batch).
// Includes anchor fields (meta_url, meta_hash) for CIP-119 metadata resolution
// and voting power amount. All nullable fields follow the live Koios response.
const drepInfoRowSchema = z
  .object({
    drep_id: z.string(),
    hex: z.string(),
    has_script: z.boolean(),
    drep_status: z.string(),
    deposit: z.string().nullable(),
    active: z.boolean(),
    expires_epoch_no: z.number().nullable(),
    amount: z.string().nullable(),
    meta_url: z.string().nullable(),
    meta_hash: z.string().nullable(),
  })
  .passthrough();

export type DrepInfoRow = z.infer<typeof drepInfoRowSchema>;

// Full /proposal_list row. Only the fields gov-sync needs are required; the rest
// is tolerated. meta_url/meta_hash drive the off-chain anchor fetch and its
// mandatory hash verification.
const proposalListRowSchema = z
  .object({
    proposal_id: z.string(),
    proposal_tx_hash: z.string(),
    proposal_index: z.number(),
    proposal_type: z.string(),
    deposit: z.string().nullable().optional(),
    return_address: z.string().nullable().optional(),
    proposed_epoch: z.number().nullable().optional(),
    // Exact submission time of the proposal's block (unix seconds). Stored (x1000)
    // as governance_actions.submitted_at so the "new" list orders by real recency.
    block_time: z.number().nullable().optional(),
    expiration: z.number().nullable().optional(),
    meta_url: z.string().nullable().optional(),
    meta_hash: z.string().nullable().optional(),
    enacted_epoch: z.number().nullable().optional(),
    ratified_epoch: z.number().nullable().optional(),
    dropped_epoch: z.number().nullable().optional(),
    expired_epoch: z.number().nullable().optional(),
    // Decoded on-chain action body (tag + contents). Persisted per action and
    // decoded at render time for the "On-chain changes" overview block.
    proposal_description: z.unknown().optional(),
  })
  .passthrough();

export type ProposalListRow = z.infer<typeof proposalListRowSchema>;

// Exported for unit tests only.
export const _proposalListRowSchemaForTest = proposalListRowSchema;

// Voting summary for one proposal. Counts are votes_cast; the *_pct fields are
// power-weighted for DRep/pool and count-weighted for committee (as Koios
// computes them). Tolerant of nulls and extra fields.
const votingSummarySchema = z
  .object({
    proposal_type: z.string().optional(),
    epoch_no: z.number().nullable().optional(),
    drep_yes_votes_cast: z.number().nullable().optional(),
    drep_no_votes_cast: z.number().nullable().optional(),
    drep_abstain_votes_cast: z.number().nullable().optional(),
    drep_yes_pct: z.number().nullable().optional(),
    drep_no_pct: z.number().nullable().optional(),
    drep_active_yes_vote_power: z.string().nullable().optional(),
    drep_active_no_vote_power: z.string().nullable().optional(),
    drep_active_abstain_vote_power: z.string().nullable().optional(),
    pool_yes_votes_cast: z.number().nullable().optional(),
    pool_no_votes_cast: z.number().nullable().optional(),
    pool_abstain_votes_cast: z.number().nullable().optional(),
    pool_yes_pct: z.number().nullable().optional(),
    pool_no_pct: z.number().nullable().optional(),
    committee_yes_votes_cast: z.number().nullable().optional(),
    committee_no_votes_cast: z.number().nullable().optional(),
    committee_abstain_votes_cast: z.number().nullable().optional(),
    committee_yes_pct: z.number().nullable().optional(),
    committee_no_pct: z.number().nullable().optional(),
  })
  .passthrough();

export type VotingSummary = z.infer<typeof votingSummarySchema>;

// One on-chain vote on a proposal. voter_id is the CIP-129 drep id / pool id /
// cc cred; vote is Yes / No / Abstain.
const proposalVoteRowSchema = z
  .object({
    voter_role: z.string(),
    voter_id: z.string(),
    voter_hex: z.string().nullable().optional(),
    vote: z.string(),
    block_time: z.number().nullable().optional(),
    meta_url: z.string().nullable().optional(),
  })
  .passthrough();

export type ProposalVoteRow = z.infer<typeof proposalVoteRowSchema>;

// One row of /drep_updates: a DRep registration/deregistration/update event.
// action is 'registered' | 'updated' | 'deregistered'; block_time is unix seconds.
// Without a _drep_id filter the endpoint returns every DRep's updates, newest first.
const drepUpdateRowSchema = z
  .object({
    drep_id: z.string(),
    action: z.string(),
    block_time: z.number().nullable().optional(),
  })
  .passthrough();

export type DrepUpdateRow = z.infer<typeof drepUpdateRowSchema>;

// One row of /pool_calidus_keys. Koios already applies the CIP-151 highest-nonce
// and revocation rules, exposing only the currently valid key per pool with
// `registered: true`. calidus_pub_key is the raw 32-byte Ed25519 public key (hex)
// used to authenticate. Extra fields (nonce, bytes, tx_hash, ...) are tolerated.
const poolCalidusKeyRowSchema = z
  .object({
    pool_id_bech32: z.string(),
    calidus_pub_key: z.string(),
    calidus_id_bech32: z.string(),
    registered: z.boolean(),
    pool_status: z.string(),
  })
  .passthrough();

export type PoolCalidusKeyRow = z.infer<typeof poolCalidusKeyRowSchema>;

// One member of the constitutional committee from /committee_info. cc_hot_hex is
// the raw 28-byte credential hash (= blake2b224 of the hot key for key-based
// members). cc_hot_has_script distinguishes key vs native-script credentials.
const committeeMemberSchema = z
  .object({
    status: z.string(),
    cc_hot_id: z.string().nullable(),
    cc_cold_id: z.string().nullable(),
    cc_hot_hex: z.string().nullable(),
    cc_cold_hex: z.string().nullable(),
    expiration_epoch: z.number().nullable(),
    cc_hot_has_script: z.boolean().nullable(),
    cc_cold_has_script: z.boolean().nullable(),
  })
  .passthrough();

export type CommitteeMember = z.infer<typeof committeeMemberSchema>;

// /committee_info returns a single-row array describing the current committee,
// whose `members` array holds the cold/hot credentials. Tolerant of extras.
// quorum_numerator and quorum_denominator carry the CIP-1694 quorum threshold.
const committeeInfoRowSchema = z
  .object({
    members: z.array(committeeMemberSchema),
    quorum_numerator: z.number().nullable().optional(),
    quorum_denominator: z.number().nullable().optional(),
  })
  .passthrough();

// /epoch_params row: latest epoch protocol params with CIP-1694 voting
// thresholds (dvt_*/pvt_*) and committee_min_size. All fields optional/nullable
// because Koios only started populating them from the Chang hard fork onward.
const epochParamsRowSchema = z.object({
  epoch_no: z.number().nullable().optional(),
  dvt_motion_no_confidence: z.number().nullable().optional(),
  dvt_committee_normal: z.number().nullable().optional(),
  dvt_committee_no_confidence: z.number().nullable().optional(),
  dvt_update_to_constitution: z.number().nullable().optional(),
  dvt_hard_fork_initiation: z.number().nullable().optional(),
  dvt_p_p_network_group: z.number().nullable().optional(),
  dvt_p_p_economic_group: z.number().nullable().optional(),
  dvt_p_p_technical_group: z.number().nullable().optional(),
  dvt_p_p_gov_group: z.number().nullable().optional(),
  dvt_treasury_withdrawal: z.number().nullable().optional(),
  pvt_motion_no_confidence: z.number().nullable().optional(),
  pvt_committee_normal: z.number().nullable().optional(),
  pvt_committee_no_confidence: z.number().nullable().optional(),
  pvt_hard_fork_initiation: z.number().nullable().optional(),
  pvtpp_security_group: z.number().nullable().optional(),
  committee_min_size: z.number().nullable().optional(),
}).passthrough();

export type EpochParamsRow = z.infer<typeof epochParamsRowSchema>;

export function createKoiosClient(opts: KoiosClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const retries = opts.retries ?? 0;
  const retryDelayMs = opts.retryDelayMs ?? 300;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? 8_000;

  // A failure is worth retrying only when it is transient: a 5xx/429 from Koios,
  // or a network/timeout error (which surfaces as a non-KoiosHttpError). Client
  // errors (4xx) would fail identically on retry, so they are not retried.
  function isTransient(err: unknown): boolean {
    if (err instanceof KoiosHttpError) return err.status >= 500 || err.status === 429;
    return true;
  }

  async function attempt(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(init.headers ?? {}),
      };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const res = await fetchImpl(`${opts.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new KoiosHttpError(res.status, parseRetryAfter(res.headers.get('retry-after')));
      }
      // Koios occasionally emits raw C0 control characters inside string values
      // (e.g. a vote's meta_url with a stray newline), which strict JSON parsing
      // rejects, failing the whole response. Strip them before parsing: they are
      // never valid unescaped inside a JSON string, and between tokens they are
      // only insignificant whitespace, so removing them cannot change the data.
      const text = await res.text();
      return JSON.parse(text.replace(/\p{Cc}/gu, ''));
    } finally {
      clearTimeout(timer);
    }
  }

  // Delay before retry attempt i: exponential backoff (base * 2^i) plus a small
  // random jitter so parallel calls do not retry in lockstep. A server-sent
  // Retry-After wins when it asks for a longer wait. Both are capped so a rogue
  // header cannot stall a cron run.
  function retryDelay(attemptIndex: number, err: unknown): number {
    const base = retryDelayMs * 2 ** attemptIndex;
    let delay = base + Math.random() * base * 0.25;
    if (err instanceof KoiosHttpError && err.retryAfterMs != null) {
      delay = Math.max(delay, err.retryAfterMs);
    }
    return Math.min(delay, maxRetryDelayMs);
  }

  // Retries transient failures with exponential backoff. Koios's proposal_voting_summary
  // is a heavy aggregation that returns 504/timeout under a burst of requests, so the
  // gov-sync cron opts into a couple of retries; the interactive auth flow leaves
  // retries at 0 (fail fast).
  async function request(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<unknown> {
    for (let i = 0; ; i++) {
      try {
        return await attempt(path, init);
      } catch (err) {
        if (i >= retries || !isTransient(err)) throw err;
        const delay = retryDelay(i, err);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async function postSingleRow<T>(
    path: string,
    bodyKey: string,
    id: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const data = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [bodyKey]: [id] }),
    });
    return z.array(schema).parse(data)[0] ?? null;
  }

  // Fetches /drep_info for a sub-batch, halving and retrying on a 413 (Koios
  // body cap) down to a single id, which is the same call the auth flow uses.
  async function drepInfoChunk(drepIds: string[]): Promise<DrepInfoRow[]> {
    try {
      const data = await request('/drep_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _drep_ids: drepIds }),
      });
      return z.array(drepInfoRowSchema).parse(data);
    } catch (err) {
      if (drepIds.length > 1 && err instanceof KoiosHttpError && err.status === 413) {
        const mid = Math.ceil(drepIds.length / 2);
        const head = await drepInfoChunk(drepIds.slice(0, mid));
        const tail = await drepInfoChunk(drepIds.slice(mid));
        return [...head, ...tail];
      }
      throw err;
    }
  }

  return {
    async tip(): Promise<Tip> {
      const data = await request('/tip', { method: 'GET' });
      return tipSchema.parse(data)[0];
    },

    // Single-drep lookup (auth flow): returns the basic DrepInfo or null.
    async drepInfo(drepId: string): Promise<DrepInfo | null> {
      return postSingleRow('/drep_info', '_drep_ids', drepId, drepInfoSchema);
    },

    // Single-script lookup: returns the script's type and native JSON, or null.
    async scriptInfo(scriptHash: string): Promise<ScriptInfo | null> {
      return postSingleRow('/script_info', '_script_hashes', scriptHash, scriptInfoSchema);
    },

    // Batch lookup (sync flow): returns the full DrepInfoRow (incl. anchor +
    // voting power) for every id, fetched in sub-batches that respect Koios's
    // /drep_info POST body cap (see DREP_INFO_MAX and drepInfoChunk's 413
    // fallback). Empty input short-circuits the round-trip.
    async drepInfoBatch(drepIds: string[]): Promise<DrepInfoRow[]> {
      if (drepIds.length === 0) return [];
      const out: DrepInfoRow[] = [];
      for (let i = 0; i < drepIds.length; i += DREP_INFO_MAX) {
        out.push(...(await drepInfoChunk(drepIds.slice(i, i + DREP_INFO_MAX))));
      }
      return out;
    },

    async accountInfo(stakeAddress: string): Promise<AccountInfo | null> {
      return postSingleRow('/account_info', '_stake_addresses', stakeAddress, accountInfoSchema);
    },

    async proposalsByReturnAddress(stakeAddress: string): Promise<Proposal[]> {
      const path = `/proposal_list?return_address=eq.${encodeURIComponent(stakeAddress)}`;
      const data = await request(path, { method: 'GET' });
      return z.array(proposalSchema).parse(data);
    },

    // Lists governance actions for gov-sync discovery. `limit` caps the page
    // (Koios paginates at 1000); governance actions are low-volume so one page
    // is enough for the realistic dataset.
    async proposalList(limit = 1000): Promise<ProposalListRow[]> {
      const path = `/proposal_list?limit=${limit}&order=proposed_epoch.desc`;
      const data = await request(path, { method: 'GET' });
      return z.array(proposalListRowSchema).parse(data);
    },

    // Enumerates all DReps. Koios paginates at 1000 rows; callers may
    // page through by incrementing offset in steps of limit.
    async drepList(limit = 1000, offset = 0): Promise<DrepListRow[]> {
      const path = `/drep_list?limit=${limit}&offset=${offset}`;
      const data = await request(path, { method: 'GET' });
      return z.array(drepListRowSchema).parse(data);
    },

    // Power-weighted tally summary for one governance action (bech32 proposal id).
    async proposalVotingSummary(proposalId: string): Promise<VotingSummary | null> {
      const path = `/proposal_voting_summary?_proposal_id=${encodeURIComponent(proposalId)}`;
      const data = await request(path, { method: 'GET' });
      return z.array(votingSummarySchema).parse(data)[0] ?? null;
    },

    // Individual on-chain votes on one governance action (paginated).
    async proposalVotes(proposalId: string, limit = 1000, offset = 0): Promise<ProposalVoteRow[]> {
      const path = `/proposal_votes?_proposal_id=${encodeURIComponent(proposalId)}&limit=${limit}&offset=${offset}`;
      const data = await request(path, { method: 'GET' });
      return z.array(proposalVoteRowSchema).parse(data);
    },

    // DRep registration/update history (paginated). Unfiltered: returns every
    // DRep's updates, newest first, used to backfill the earliest registration epoch.
    async drepUpdates(limit = 1000, offset = 0): Promise<DrepUpdateRow[]> {
      const path = `/drep_updates?limit=${limit}&offset=${offset}`;
      const data = await request(path, { method: 'GET' });
      return z.array(drepUpdateRowSchema).parse(data);
    },

    // Calidus-key lookup (SPO auth flow): resolves a raw Ed25519 calidus public
    // key (hex) to its pool. Koios returns only the currently valid registration
    // (highest nonce, not revoked) with `registered: true`. Returns null when the
    // key is not a registered calidus key on this network.
    async poolCalidusKey(calidusPubKeyHex: string): Promise<PoolCalidusKeyRow | null> {
      const path =
        `/pool_calidus_keys?calidus_pub_key=eq.${encodeURIComponent(calidusPubKeyHex)}` +
        `&select=pool_id_bech32,calidus_pub_key,calidus_id_bech32,registered,pool_status`;
      const data = await request(path, { method: 'GET' });
      return z.array(poolCalidusKeyRowSchema).parse(data)[0] ?? null;
    },

    // Constitutional committee membership (CC auth flow): returns the current
    // committee members with their cold/hot credentials. Empty array when there
    // is no committee row.
    async committeeInfo(): Promise<CommitteeMember[]> {
      const data = await request('/committee_info', { method: 'GET' });
      const row = z.array(committeeInfoRowSchema).parse(data)[0];
      return row?.members ?? [];
    },

    // The committee's quorum threshold as a fraction (numerator/denominator),
    // or null when there is no committee or the fields are absent.
    async committeeQuorum(): Promise<number | null> {
      const data = await request('/committee_info', { method: 'GET' });
      const row = z.array(committeeInfoRowSchema).parse(data)[0];
      if (!row?.quorum_numerator || !row?.quorum_denominator) return null;
      return row.quorum_numerator / row.quorum_denominator;
    },

    // Latest epoch's protocol params; carries the CIP-1694 voting thresholds
    // (dvt_*/pvt_*) and committee_min_size. One row (limit 1, newest first).
    async epochParams(): Promise<EpochParamsRow | null> {
      const data = await request('/epoch_params?limit=1', { method: 'GET' });
      return z.array(epochParamsRowSchema).parse(data)[0] ?? null;
    },
  };
}
