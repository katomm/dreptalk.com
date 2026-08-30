import { z } from 'zod';
import { KOIOS_BATCH_CONCURRENCY, mapLimit } from './concurrency';

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
// live_delegator_count is Koios's per-DRep delegator headcount ("delegators whose
// last voting power delegation was to this DRep"); optional so a network that has
// not yet exposed it parses cleanly, in which case the count is treated as unknown.
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
    // Shout out to the Koios team for adding live_delegator_count to /drep_info:
    // it lets us drop a per-DRep count request and read the headcount straight off
    // the row we already fetch.
    live_delegator_count: z.number().nullable().optional(),
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
    // Raw stake-power buckets (lovelace strings). Needed to recompute the SPO
    // percentage for HardForkInitiation, where Koios' pool_*_pct does not match
    // the ledger (see spoTallyPct in koios/corrections.ts).
    pool_active_yes_vote_power: z.string().nullable().optional(),
    pool_active_no_vote_power: z.string().nullable().optional(),
    pool_active_abstain_vote_power: z.string().nullable().optional(),
    pool_no_vote_power: z.string().nullable().optional(),
    pool_passive_always_abstain_vote_power: z.string().nullable().optional(),
    pool_passive_always_no_confidence_vote_power: z.string().nullable().optional(),
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
    meta_hash: z.string().nullable().optional(),
  })
  .passthrough();

export type ProposalVoteRow = z.infer<typeof proposalVoteRowSchema>;

// One row of /vote_list filtered to a single voter and proposal: the full vote
// history for that pair (re-votes included), used to recover anchor hashes.
const voteListRowSchema = z
  .object({
    block_time: z.number().nullable().optional(),
    meta_url: z.string().nullable().optional(),
    meta_hash: z.string().nullable().optional(),
  })
  .passthrough();

export type VoteListRow = z.infer<typeof voteListRowSchema>;

// One row of /vote_list filtered to a single proposal (all voters, all roles):
// every vote transaction ever cast on the action, used by the vote-history
// sweep to reconstruct re-vote chains.
const actionVoteListRowSchema = z
  .object({
    voter_id: z.string(),
    voter_role: z.string(),
    vote: z.string(),
    block_time: z.number().nullable().optional(),
    meta_url: z.string().nullable().optional(),
    meta_hash: z.string().nullable().optional(),
  })
  .passthrough();

export type ActionVoteListRow = z.infer<typeof actionVoteListRowSchema>;

// One row of /pool_info. meta_json is the validated base off-chain metadata
// (ticker/name/homepage/description); Koios omits the CIP-6 `extended` field, so
// the logo URL is resolved separately from the raw meta_url document.
const poolInfoRowSchema = z
  .object({
    pool_id_bech32: z.string(),
    pool_id_hex: z.string().nullable().optional(),
    // Active (delegated) stake in lovelace at the current epoch; the SPO voting
    // weight. String because it exceeds JS safe-integer range. Nullable pre-first-epoch.
    active_stake: z.string().nullable().optional(),
    meta_url: z.string().nullable().optional(),
    meta_hash: z.string().nullable().optional(),
    meta_json: z
      .object({
        ticker: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        homepage: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type PoolInfoRow = z.infer<typeof poolInfoRowSchema>;

// Koios /pool_info POST body cap; pool_info rows are large, keep the sub-batch modest.
const POOL_INFO_MAX = 50;

// Koios caps the /account_info POST body. Mirrors DREP_INFO_MAX / POOL_INFO_MAX;
// the client halves and retries on a 413, so even a lower cap still completes.
const ACCOUNT_INFO_MAX = 100;

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

// One row of /drep_voting_power_history: a DRep's voting power snapshot for a
// single epoch. amount is the snapshotted lovelace (nullable in the Koios
// response). Unfiltered (no _drep_id) the endpoint returns every DRep for the
// requested epoch, which is how the trend sync captures a whole epoch at once.
const drepVotingPowerHistoryRowSchema = z
  .object({
    drep_id: z.string(),
    epoch_no: z.number(),
    amount: z.string().nullable(),
  })
  .passthrough();

export type DrepVotingPowerHistoryRow = z.infer<typeof drepVotingPowerHistoryRowSchema>;

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

// /totals row: per-epoch treasury and reserves balances (lovelace, as strings
// since they exceed safe integer range).
const totalsRowSchema = z.object({
  epoch_no: z.number(),
  treasury: z.string(),
  reserves: z.string(),
}).passthrough();

// /drep_delegators row: a stake account currently vote-delegated to a DRep.
// epoch_no is the epoch of the NEWEST delegation cert (validated live), so it
// is only a pre-filter: the provenance stint logic decides real arrivals.
const drepDelegatorRowSchema = z.object({
  stake_address: z.string(),
  amount: z.string(),
  epoch_no: z.number(),
}).passthrough();
export type DrepDelegatorRow = z.infer<typeof drepDelegatorRowSchema>;

// /account_update_history: flat per-event rows (successor of the deprecated
// nested /account_updates). Consumers filter to delegation_drep.
const accountUpdateHistoryRowSchema = z.object({
  stake_address: z.string(),
  action_type: z.string(),
  tx_hash: z.string(),
  epoch_no: z.number(),
  absolute_slot: z.number(),
}).passthrough();
export type AccountUpdateHistoryRow = z.infer<typeof accountUpdateHistoryRowSchema>;

// /tx_info with _certs: only the certificate list is consumed, the per-cert
// info payload differs by type and is narrowed at the use site.
const txCertSchema = z.object({
  type: z.string(),
  info: z.unknown(),
}).passthrough();
export type TxCert = z.infer<typeof txCertSchema>;
const txInfoCertsRowSchema = z.object({
  tx_hash: z.string(),
  certificates: z.array(txCertSchema).nullable(),
}).passthrough();
export type TxInfoCertsRow = z.infer<typeof txInfoCertsRowSchema>;

// /account_update_history returns one flat row per event, so PostgREST's
// 1000-row page cap is reachable well below the POST body limit (measured:
// 40 active accounts produced ~600 rows). Chunk small and halve on a capped
// response, TX_INFO_MAX bounds the certs lookups.
const ACCOUNT_UPDATE_HISTORY_MAX = 15;
const TX_INFO_MAX = 25;
const KOIOS_PAGE_CAP = 1000;

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

  // Retries a transient failure (5xx/429 or a network error) with exponential
  // backoff; client errors and the retry ceiling propagate. Shared by every
  // request transport so the retry policy lives in one place.
  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= retries || !isTransient(err)) throw err;
        const delay = retryDelay(i, err);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Retries transient failures with exponential backoff. Koios's proposal_voting_summary
  // is a heavy aggregation that returns 504/timeout under a burst of requests, so the
  // gov-sync cron opts into a couple of retries; the interactive auth flow leaves
  // retries at 0 (fail fast).
  async function request(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<unknown> {
    return withRetry(() => attempt(path, init));
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

  // Fetches /pool_info for a sub-batch, halving and retrying on a 413 (Koios
  // body cap) down to a single id, matching the drepInfoChunk pattern.
  async function poolInfoChunk(poolIds: string[]): Promise<PoolInfoRow[]> {
    try {
      const data = await request('/pool_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _pool_bech32_ids: poolIds }),
      });
      return z.array(poolInfoRowSchema).parse(data);
    } catch (err) {
      if (poolIds.length > 1 && err instanceof KoiosHttpError && err.status === 413) {
        const mid = Math.ceil(poolIds.length / 2);
        const head = await poolInfoChunk(poolIds.slice(0, mid));
        const tail = await poolInfoChunk(poolIds.slice(mid));
        return [...head, ...tail];
      }
      throw err;
    }
  }

  // Fetches /account_info for a sub-batch, halving and retrying on a 413 (Koios
  // body cap) down to a single address, matching the drepInfoChunk pattern. A
  // requested address absent from the response has no account row (not registered).
  async function accountInfoChunk(stakeAddresses: string[]): Promise<AccountInfo[]> {
    try {
      const data = await request('/account_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _stake_addresses: stakeAddresses }),
      });
      return z.array(accountInfoSchema).parse(data);
    } catch (err) {
      if (err instanceof KoiosHttpError && err.status === 413 && stakeAddresses.length > 1) {
        const mid = Math.floor(stakeAddresses.length / 2);
        const head = await accountInfoChunk(stakeAddresses.slice(0, mid));
        const tail = await accountInfoChunk(stakeAddresses.slice(mid));
        return [...head, ...tail];
      }
      throw err;
    }
  }

  // Pages one address's history by offset until a short page. Only needed for
  // the rare account whose own event count reaches the page cap.
  async function accountUpdateHistorySingle(stakeAddress: string): Promise<AccountUpdateHistoryRow[]> {
    const out: AccountUpdateHistoryRow[] = [];
    for (let offset = 0; ; offset += KOIOS_PAGE_CAP) {
      const data = await request(`/account_update_history?limit=${KOIOS_PAGE_CAP}&offset=${offset}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
      });
      const rows = z.array(accountUpdateHistoryRowSchema).parse(data);
      out.push(...rows);
      if (rows.length < KOIOS_PAGE_CAP) return out;
    }
  }

  // A response of exactly the page cap means rows were silently dropped
  // (PostgREST caps, it does not error), so a capped response halves the chunk
  // like a 413 does. A single capped address falls back to offset paging.
  async function accountUpdateHistoryChunk(stakeAddresses: string[]): Promise<AccountUpdateHistoryRow[]> {
    try {
      const data = await request('/account_update_history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _stake_addresses: stakeAddresses }),
      });
      const rows = z.array(accountUpdateHistoryRowSchema).parse(data);
      if (rows.length >= KOIOS_PAGE_CAP) {
        if (stakeAddresses.length === 1) return accountUpdateHistorySingle(stakeAddresses[0]);
        const mid = Math.floor(stakeAddresses.length / 2);
        const head = await accountUpdateHistoryChunk(stakeAddresses.slice(0, mid));
        const tail = await accountUpdateHistoryChunk(stakeAddresses.slice(mid));
        return [...head, ...tail];
      }
      return rows;
    } catch (err) {
      if (err instanceof KoiosHttpError && err.status === 413 && stakeAddresses.length > 1) {
        const mid = Math.floor(stakeAddresses.length / 2);
        const head = await accountUpdateHistoryChunk(stakeAddresses.slice(0, mid));
        const tail = await accountUpdateHistoryChunk(stakeAddresses.slice(mid));
        return [...head, ...tail];
      }
      throw err;
    }
  }

  async function txInfoCertsChunk(txHashes: string[]): Promise<TxInfoCertsRow[]> {
    try {
      const data = await request('/tx_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Only certificates are needed, every other section is switched off to
        // keep the response small (tx_info is heavy by default).
        body: JSON.stringify({
          _tx_hashes: txHashes,
          _certs: true,
          _inputs: false,
          _metadata: false,
          _assets: false,
          _withdrawals: false,
          _scripts: false,
        }),
      });
      return z.array(txInfoCertsRowSchema).parse(data);
    } catch (err) {
      if (err instanceof KoiosHttpError && err.status === 413 && txHashes.length > 1) {
        const mid = Math.floor(txHashes.length / 2);
        const head = await txInfoCertsChunk(txHashes.slice(0, mid));
        const tail = await txInfoCertsChunk(txHashes.slice(mid));
        return [...head, ...tail];
      }
      throw err;
    }
  }

  // One fetch+parse for /committee_info, shared by the member and summary views
  // below so the two cannot drift on schema or error handling.
  async function committeeRow() {
    const data = await request('/committee_info', { method: 'GET' });
    return z.array(committeeInfoRowSchema).parse(data)[0];
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

    // Batch lookup for pool metadata: ticker, name, homepage, meta_url/hash.
    // Sub-batched by POOL_INFO_MAX with 413-halving fallback. Empty input
    // short-circuits the round-trip.
    async poolInfoBatch(poolIds: string[]): Promise<PoolInfoRow[]> {
      if (poolIds.length === 0) return [];
      const out: PoolInfoRow[] = [];
      for (let i = 0; i < poolIds.length; i += POOL_INFO_MAX) {
        out.push(...(await poolInfoChunk(poolIds.slice(i, i + POOL_INFO_MAX))));
      }
      return out;
    },

    async accountInfo(stakeAddress: string): Promise<AccountInfo | null> {
      return postSingleRow('/account_info', '_stake_addresses', stakeAddress, accountInfoSchema);
    },

    // Batch lookup for the daily delegation refresh: returns account status
    // (incl. delegated_drep) for every address, fetched in sub-batches that
    // respect Koios's /account_info POST body cap (see ACCOUNT_INFO_MAX and
    // accountInfoChunk's 413 fallback). A successfully returned array is
    // authoritative: an address absent from it has no account row (never
    // registered), it is not a silent partial failure. A chunk that errors
    // (after exhausting the 413 halving) throws, failing the whole batch
    // rather than returning a partial result. Empty input short-circuits the
    // round-trip.
    async accountInfoBatch(stakeAddresses: string[]): Promise<AccountInfo[]> {
      if (stakeAddresses.length === 0) return [];
      const out: AccountInfo[] = [];
      for (let i = 0; i < stakeAddresses.length; i += ACCOUNT_INFO_MAX) {
        out.push(...(await accountInfoChunk(stakeAddresses.slice(i, i + ACCOUNT_INFO_MAX))));
      }
      return out;
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

    // Individual on-chain votes on one governance action (paginated). Caveat:
    // Koios silently omits votes cast by DReps that have since deregistered, so
    // the list can miss (or later lose) voters; /vote_list keeps the full record.
    async proposalVotes(proposalId: string, limit = 1000, offset = 0): Promise<ProposalVoteRow[]> {
      const path = `/proposal_votes?_proposal_id=${encodeURIComponent(proposalId)}&limit=${limit}&offset=${offset}`;
      const data = await request(path, { method: 'GET' });
      return z.array(proposalVoteRowSchema).parse(data);
    },

    // Every vote transaction on one action (all voters and roles), oldest
    // first so re-vote chains reconstruct by walking forward. Like the
    // per-voter variant below, /vote_list keeps superseded votes and votes by
    // since-deregistered voters. Paginated (Koios caps at 1000 rows).
    async actionVoteList(proposalId: string, limit = 1000, offset = 0): Promise<ActionVoteListRow[]> {
      const path =
        `/vote_list?proposal_id=eq.${encodeURIComponent(proposalId)}` +
        `&select=voter_id,voter_role,vote,block_time,meta_url,meta_hash` +
        `&order=block_time.asc&limit=${limit}&offset=${offset}`;
      const data = await request(path, { method: 'GET' });
      return z.array(actionVoteListRowSchema).parse(data);
    },

    // One voter's full vote history on one governance action, newest first.
    // Unlike /proposal_votes, /vote_list keeps votes cast by since-deregistered
    // DReps, so it can recover anchor hashes /proposal_votes no longer returns.
    async voterProposalVoteList(voterId: string, proposalId: string): Promise<VoteListRow[]> {
      const path =
        `/vote_list?voter_id=eq.${encodeURIComponent(voterId)}` +
        `&proposal_id=eq.${encodeURIComponent(proposalId)}` +
        `&select=block_time,meta_url,meta_hash&order=block_time.desc`;
      const data = await request(path, { method: 'GET' });
      return z.array(voteListRowSchema).parse(data);
    },

    // DRep registration/update history (paginated). Unfiltered: returns every
    // DRep's updates, newest first, used to backfill the earliest registration epoch.
    async drepUpdates(limit = 1000, offset = 0): Promise<DrepUpdateRow[]> {
      const path = `/drep_updates?limit=${limit}&offset=${offset}`;
      const data = await request(path, { method: 'GET' });
      return z.array(drepUpdateRowSchema).parse(data);
    },

    // Every DRep's voting power snapshot for one epoch (paginated). Without a
    // _drep_id filter the endpoint returns the whole epoch, so the trend sync
    // pages through it to capture all DReps; callers increment offset by limit.
    async drepVotingPowerHistory(
      epochNo: number,
      limit = 1000,
      offset = 0,
    ): Promise<DrepVotingPowerHistoryRow[]> {
      const path = `/drep_voting_power_history?_epoch_no=${epochNo}&limit=${limit}&offset=${offset}`;
      const data = await request(path, { method: 'GET' });
      return z.array(drepVotingPowerHistoryRowSchema).parse(data);
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
      return (await committeeRow())?.members ?? [];
    },

    // Quorum threshold (numerator/denominator as a fraction) plus the member
    // list, from one /committee_info call. Members is null (not []) when there
    // is no committee row, so callers can tell "no data" from "empty committee".
    async committeeSummary(): Promise<{ quorum: number | null; members: CommitteeMember[] | null }> {
      const row = await committeeRow();
      if (!row) return { quorum: null, members: null };
      const quorum =
        row.quorum_numerator && row.quorum_denominator
          ? row.quorum_numerator / row.quorum_denominator
          : null;
      return { quorum, members: row.members };
    },

    // Latest epoch's protocol params; carries the CIP-1694 voting thresholds
    // (dvt_*/pvt_*) and committee_min_size. One row (limit 1, newest first).
    async epochParams(epochNo?: number): Promise<EpochParamsRow | null> {
      const path = epochNo != null ? `/epoch_params?_epoch_no=${epochNo}&limit=1` : '/epoch_params?limit=1';
      const data = await request(path, { method: 'GET' });
      return z.array(epochParamsRowSchema).parse(data)[0] ?? null;
    },

    // Latest epoch's treasury and reserves balances (lovelace). One row
    // (newest epoch first, limit 1).
    async totals(): Promise<{ epochNo: number; treasuryLovelace: string; reservesLovelace: string } | null> {
      const data = await request('/totals?order=epoch_no.desc&limit=1', { method: 'GET' });
      const row = z.array(totalsRowSchema).parse(data)[0] ?? null;
      if (!row) return null;
      return { epochNo: row.epoch_no, treasuryLovelace: row.treasury, reservesLovelace: row.reserves };
    },

    // Pages the current delegator set of a DRep, callers increment offset by
    // limit until a page comes back shorter than limit.
    async drepDelegators(drepId: string, limit = 1000, offset = 0): Promise<DrepDelegatorRow[]> {
      const path = `/drep_delegators?_drep_id=${encodeURIComponent(drepId)}&limit=${limit}&offset=${offset}`;
      const data = await request(path, { method: 'GET' });
      return z.array(drepDelegatorRowSchema).parse(data);
    },

    // Flat certificate history for the provenance analysis. Sub-batched by
    // ACCOUNT_UPDATE_HISTORY_MAX with 413-halving AND page-cap-halving (see
    // accountUpdateHistoryChunk). Empty input short-circuits.
    async accountUpdateHistoryBatch(stakeAddresses: string[]): Promise<AccountUpdateHistoryRow[]> {
      const chunks: string[][] = [];
      for (let i = 0; i < stakeAddresses.length; i += ACCOUNT_UPDATE_HISTORY_MAX) {
        chunks.push(stakeAddresses.slice(i, i + ACCOUNT_UPDATE_HISTORY_MAX));
      }
      // Chunks run with bounded concurrency, each keeping its own page-cap
      // and 413 halving. Results stay in input chunk order.
      const results = await mapLimit(chunks, KOIOS_BATCH_CONCURRENCY, accountUpdateHistoryChunk);
      return results.flat();
    },

    // Batch cert lookup: certificates only, every heavy tx_info section off.
    // Sub-batched by TX_INFO_MAX with 413-halving, chunks fetched with
    // bounded concurrency. Empty input short-circuits.
    async txInfoCertsBatch(txHashes: string[]): Promise<TxInfoCertsRow[]> {
      const chunks: string[][] = [];
      for (let i = 0; i < txHashes.length; i += TX_INFO_MAX) {
        chunks.push(txHashes.slice(i, i + TX_INFO_MAX));
      }
      const results = await mapLimit(chunks, KOIOS_BATCH_CONCURRENCY, txInfoCertsChunk);
      return results.flat();
    },
  };
}
