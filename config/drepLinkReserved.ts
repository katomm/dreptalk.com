// Handles that neither the automatic assignment nor a DRep claim may take.
// Compared without hyphens, so "cardanofoundation" is as reserved as
// "cardano-foundation". Longer names that merely contain one of these words stay
// free. Organisation handles are assigned by hand after checking that the DRep
// really is that organisation.
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Technical and site words
  'api', 'www', 'admin', 'help', 'about', 'login', 'settings', 'search', 'dreps', 'drep',
  'dreptalk', 'robots-txt', 'favicon-ico', 'static', 'assets', 'status', 'support', 'official',
  // Organisations and wallets
  'intersect', 'intersectmbo', 'iohk', 'iog', 'ioe', 'input-output', 'input-output-global',
  'emurgo', 'cardano', 'cardano-foundation', 'cardano-org', 'cf', 'govtool', 'catalyst',
  'project-catalyst', 'midnight', 'lace', 'eternl', 'typhon', 'vespr', 'yoroi',
  'sundaeswap', 'minswap', 'liqwid', 'gimbalabs',
  // People
  'charles', 'hoskinson', 'charles-hoskinson',
]);
