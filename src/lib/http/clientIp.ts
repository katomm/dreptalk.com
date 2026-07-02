// Extracts the originating client IP from a request's headers for per-IP rate
// limiting. Uses ONLY Cloudflare's cf-connecting-ip, which the edge sets and a
// client cannot spoof. x-forwarded-for is deliberately not consulted: it is
// client-controlled, so trusting it (even as a fallback) would let an attacker
// rotate the header to distribute their requests across rate-limit buckets and
// evade the throttle. Requests without cf-connecting-ip (which should not happen
// behind Cloudflare) share a single "unknown" bucket rather than a spoofable value.
export function clientIpFrom(headers: Headers): string {
  return headers.get('cf-connecting-ip') ?? 'unknown';
}
