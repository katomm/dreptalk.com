// The only import site for the vendored cardenticon. Seed rule: for a DRep pass
// the raw credential hex (dreps.hex); for any other author pass its authorId
// (a stake address decodes natively). Output is an inline SVG string (SSR-safe,
// no script), used by AuthorIdentity and the profile page.
import { cardenticon } from '@/vendor/cardenticon/index.js';

export function identiconSvg(seed: string, size = 28): string {
  return cardenticon(seed, { size });
}
