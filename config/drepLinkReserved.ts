// Handles that neither the automatic assignment nor a DRep claim may take.
// Exact matches only. Organisation handles are assigned by hand after checking
// that the DRep really is that organisation.
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Technical and site words
  'api', 'www', 'admin', 'help', 'about', 'login', 'settings', 'search', 'dreps', 'drep',
  'dreptalk', 'robots-txt', 'favicon-ico', 'static', 'assets', 'status', 'support', 'official',
  // Organisations and wallets
  'intersect', 'iohk', 'iog', 'input-output', 'emurgo', 'cardano', 'cardano-foundation', 'cf',
  'govtool', 'catalyst', 'midnight', 'lace', 'eternl', 'typhon', 'vespr', 'yoroi',
]);
