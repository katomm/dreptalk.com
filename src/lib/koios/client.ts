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

export function createKoiosClient(opts: KoiosClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const res = await fetchImpl(`${opts.baseUrl}${path}`, {
        ...init,
        headers,
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
  };
}
