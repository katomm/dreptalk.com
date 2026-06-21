// Canonical ADA display helpers. Lovelace in, human ADA out, always with the ₳
// symbol so the whole site reads the same. `formatAda` is the full form
// ("39,558,963 ₳", rounded to whole ADA; UIs never do sub-ADA accounting);
// `formatAdaCompact` abbreviates large amounts ("39.6M ₳", "950K ₳") for tight
// spots like sidebars, voter lists and turnout bars. Both return null when the
// value is absent or non-numeric, so each caller decides whether to hide the
// amount or fall back to "0 ₳".

const SYMBOL = '₳';

function toAda(lovelace: string | number | null | undefined): number | null {
  if (lovelace === null || lovelace === undefined || lovelace === '') return null;
  const n = Number(lovelace);
  if (!Number.isFinite(n)) return null;
  return n / 1_000_000;
}

/** Full ADA from lovelace: "100,000 ₳" (rounded). Null when absent/non-numeric. */
export function formatAda(lovelace: string | number | null | undefined): string | null {
  const ada = toAda(lovelace);
  if (ada === null) return null;
  return `${Math.round(ada).toLocaleString('en-US')} ${SYMBOL}`;
}

/**
 * Compact ADA from lovelace: "3.21B ₳" / "39.6M ₳" / "950K ₳". Null when
 * absent/non-numeric. Defaults to one fraction digit; pass 2 where the extra
 * resolution matters (e.g. comparing turnout totals in the billions).
 */
export function formatAdaCompact(
  lovelace: string | number | null | undefined,
  maximumFractionDigits = 1,
): string | null {
  const ada = toAda(lovelace);
  if (ada === null) return null;
  const short = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits,
  }).format(ada);
  return `${short} ${SYMBOL}`;
}
