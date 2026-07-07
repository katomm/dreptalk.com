// PostgREST returns an exact row count in the Content-Range response header when
// the request carries `Prefer: count=exact`, e.g. "0-0/1659" or "*/0". Koios is
// PostgREST, so this is how we read a total (delegator headcount) without
// downloading the rows. Returns null when the total is "*" (unknown) or the
// header is absent or malformed.
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf('/');
  if (slash === -1) return null;
  const total = header.slice(slash + 1).trim();
  if (!/^\d+$/.test(total)) return null;
  return Number(total);
}
