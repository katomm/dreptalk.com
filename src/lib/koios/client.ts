import { z } from 'zod';

export interface KoiosClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

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
    expiration: z.number().nullable().optional(),
    meta_url: z.string().nullable().optional(),
    meta_hash: z.string().nullable().optional(),
    enacted_epoch: z.number().nullable().optional(),
    ratified_epoch: z.number().nullable().optional(),
    dropped_epoch: z.number().nullable().optional(),
    expired_epoch: z.number().nullable().optional(),
  })
  .passthrough();

export type ProposalListRow = z.infer<typeof proposalListRowSchema>;

export function createKoiosClient(opts: KoiosClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function request(
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
        throw new Error(`koios request failed: ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
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

  return {
    async tip(): Promise<Tip> {
      const data = await request('/tip', { method: 'GET' });
      return tipSchema.parse(data)[0];
    },

    // Single-drep lookup (auth flow): returns the basic DrepInfo or null.
    async drepInfo(drepId: string): Promise<DrepInfo | null> {
      return postSingleRow('/drep_info', '_drep_ids', drepId, drepInfoSchema);
    },

    // Batch lookup (sync flow): returns the full DrepInfoRow (incl. anchor +
    // voting power) for every id. Empty input short-circuits the round-trip.
    async drepInfoBatch(drepIds: string[]): Promise<DrepInfoRow[]> {
      if (drepIds.length === 0) return [];
      const data = await request('/drep_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _drep_ids: drepIds }),
      });
      return z.array(drepInfoRowSchema).parse(data);
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
  };
}
