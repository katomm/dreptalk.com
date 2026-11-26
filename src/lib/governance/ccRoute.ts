// Request validation for /cc/<cold-key-hex>/, kept pure so it can run before any DB read.
export type CcRouteParam = { kind: 'canonical'; hex: string } | { kind: 'redirect'; hex: string } | { kind: 'invalid' };

const COLD_KEY_HEX = /^[0-9a-fA-F]{56}$/;

/** 56 hex chars: canonical when already lower-case, a redirect target otherwise. */
export function resolveCcRouteParam(param: string): CcRouteParam {
  if (!COLD_KEY_HEX.test(param)) return { kind: 'invalid' };
  const hex = param.toLowerCase();
  return hex === param ? { kind: 'canonical', hex } : { kind: 'redirect', hex };
}
