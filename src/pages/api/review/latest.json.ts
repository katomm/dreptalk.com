// GET /api/review/latest.json. The newest Governance Review edition in this
// deployment: number, slug and title. Read by the gov-sync cron through its
// service binding to announce a new edition, and public since every field is
// on the index page anyway. Served from the bundled collection, no database.
import type { APIRoute } from 'astro';
import { jsonResponse, currentNetwork } from '@/lib/api/response';
import { loadEditions, editionSlug } from '@/lib/review/editions';
import { isMainnet } from '@/lib/review/units';

export const prerender = false;

export const GET: APIRoute = async () => {
  // Mainnet only, like state.json: preprod deployments carry the same mainnet
  // editions and must not announce them to preprod accounts.
  if (!isMainnet(currentNetwork())) return jsonResponse({ error: 'governance review is mainnet only' }, 404);
  const [latest] = await loadEditions();
  if (!latest) return jsonResponse({ error: 'no edition' }, 404);
  return jsonResponse(
    { edition: latest.data.edition, slug: editionSlug(latest), title: latest.data.title },
    200,
    { 'Cache-Control': 'public, max-age=60' },
  );
};
