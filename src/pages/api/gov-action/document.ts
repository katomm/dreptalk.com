// POST /api/gov-action/document
// Finalizes a NewConstitution document submission: hashes the exact submitted
// text, pins it to IPFS, and stores an audit row. preprod-only for now.
// Unlike metadata.ts, the gate lives inside handleConstitutionDocument
// itself, so this route only delegates.
import type { APIRoute } from 'astro';
import { handleConstitutionDocument } from '@/lib/governance/constitutionDocumentHandler';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  return handleConstitutionDocument({ request, locals });
};
