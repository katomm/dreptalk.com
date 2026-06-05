import type { APIRoute } from 'astro';
import { buildHealthPayload } from '@/lib/health';

export const prerender = false;

export const GET: APIRoute = ({ locals }) => {
  const env = (locals as any).runtime?.env ?? {};
  try {
    const payload = buildHealthPayload(env.CARDANO_NETWORK);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return new Response(
      JSON.stringify({ status: 'error', error: 'invalid network configuration' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
};
