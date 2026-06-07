// Extracts the originating client IP from a request's headers for per-IP rate
// limiting. Prefers Cloudflare's cf-connecting-ip, then the first x-forwarded-for
// hop, and falls back to a shared "unknown" bucket when neither is present.
export function clientIpFrom(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
