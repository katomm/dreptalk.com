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

// DrepInfo schema: tolerate extra fields, nullable deposit and expires_epoch_no.
const drepInfoSchema = z.object({
  drep_id: z.string(),
  hex: z.string(),
  has_script: z.boolean(),
  registered: z.boolean(),
  deposit: z.string().nullable(),
  active: z.boolean(),
  expires_epoch_no: z.number().nullable(),
}).passthrough();

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

  return {
    async tip(): Promise<Tip> {
      const data = await request('/tip', { method: 'GET' });
      return tipSchema.parse(data)[0];
    },

    async drepInfo(drepId: string): Promise<DrepInfo | null> {
      const data = await request('/drep_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _drep_ids: [drepId] }),
      });
      const rows = z.array(drepInfoSchema).parse(data);
      return rows[0] ?? null;
    },

    async accountInfo(stakeAddress: string): Promise<AccountInfo | null> {
      const data = await request('/account_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
      });
      const rows = z.array(accountInfoSchema).parse(data);
      return rows[0] ?? null;
    },

    async proposalsByReturnAddress(
      stakeAddress: string,
    ): Promise<Array<{ proposal_id: string; return_address: string; proposal_type: string }>> {
      const path = `/proposal_list?return_address=eq.${encodeURIComponent(stakeAddress)}`;
      const data = await request(path, { method: 'GET' });
      return z.array(proposalSchema).parse(data);
    },
  };
}
