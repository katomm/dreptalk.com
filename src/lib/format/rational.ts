// Exact rational numbers for protocol parameters. The constitution's
// guardrails script compares rationals exactly, so a value is never rounded
// between the input field and the transaction. Leaf module: no SDK import,
// safe for every chunk.

export interface Rational {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** The reduced form, with the sign on the numerator. Throws on a zero denominator. */
export function reduce(r: Rational): Rational {
  if (r.d === 0n) throw new Error('A rational needs a nonzero denominator.');
  if (r.n === 0n) return { n: 0n, d: 1n };
  const sign = r.d < 0n ? -1n : 1n;
  const g = gcd(r.n, r.d);
  return { n: (sign * r.n) / g, d: (sign * r.d) / g };
}

/** Compares two rationals with positive denominators by cross multiplication. */
export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function equalRational(a: Rational, b: Rational): boolean {
  return compareRational(a, b) === 0;
}

const DECIMAL_RE = /^(\d*)(?:\.(\d+))?$/;

/**
 * Parses one plain, non-negative decimal exactly. Spaces around it are
 * ignored, and a single comma with no dot counts as the decimal point, so
 * "0,35" reads like "0.35". Thousands separators, signs, exponents and units
 * are refused.
 */
export function parseDecimal(
  input: string,
  maxPlaces: number,
): { ok: true; value: Rational } | { ok: false; error: 'nan' | 'places' } {
  let s = input.trim();
  if (!s.includes('.') && (s.match(/,/g) ?? []).length === 1) s = s.replace(',', '.');
  const m = DECIMAL_RE.exec(s);
  if (!m || (m[1] === '' && m[2] === undefined)) return { ok: false, error: 'nan' };
  const whole = m[1] === '' ? '0' : m[1];
  const frac = m[2] ?? '';
  if (frac.length > maxPlaces) return { ok: false, error: 'places' };
  return { ok: true, value: reduce({ n: BigInt(whole + frac), d: 10n ** BigInt(frac.length) }) };
}

/**
 * The rational a float prints as. Koios reports unit intervals as JSON
 * numbers, which are the ledger's decimal form whenever that terminates.
 */
export function rationalFromNumber(x: number): Rational | null {
  if (!Number.isFinite(x)) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(x));
  if (!m) return null;
  const frac = m[3] ?? '';
  const exp = Number(m[4] ?? '0') - frac.length;
  let n = BigInt(m[2] + frac);
  if (m[1] === '-') n = -n;
  return exp >= 0 ? reduce({ n: n * 10n ** BigInt(exp), d: 1n }) : reduce({ n, d: 10n ** BigInt(-exp) });
}

export function rationalToNumber(r: Rational): number {
  return Number(r.n) / Number(r.d);
}

/**
 * The decimal form of a non-negative rational. Exact when it terminates
 * within maxFractionDigits, otherwise rounded down to that many digits and
 * marked with "≈", so a shortened value never passes for the exact one.
 */
export function formatRationalDecimal(r: Rational, maxFractionDigits = 12): string {
  const { n, d } = reduce(r);
  const whole = n / d;
  let rest = n % d;
  let digits = '';
  while (rest !== 0n && digits.length < maxFractionDigits) {
    rest *= 10n;
    digits += (rest / d).toString();
    rest %= d;
  }
  const trimmed = digits.replace(/0+$/, '');
  const body = trimmed ? `${whole}.${trimmed}` : whole.toString();
  return rest === 0n ? body : `≈${body}`;
}

export function formatRationalPercent(r: Rational): string {
  return `${formatRationalDecimal({ n: r.n * 100n, d: r.d })}%`;
}

/** Lovelace as ada with every significant digit: "170 ₳", "170.000001 ₳", "100,000 ₳". */
export function formatLovelaceExact(lovelace: bigint): string {
  const whole = (lovelace / 1_000_000n).toLocaleString('en-US');
  const frac = (lovelace % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${frac ? `${whole}.${frac}` : whole} ₳`;
}
