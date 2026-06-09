// Custom Cloudflare Worker entry (wrangler.toml `main`).
//
// The @astrojs/cloudflare adapter's bare entrypoint cannot export custom classes,
// so to ship the RateLimiter Durable Object in the app worker we provide our own
// entry: it re-exports the DO class and delegates all requests to the adapter's
// handle(), which still renders SSR. See the adapter's Durable Objects guide.
import { handle } from '@astrojs/cloudflare/handler';

export { RateLimiter } from './lib/rateLimiterDO.js';

export default {
  fetch(request, env, ctx): Promise<Response> {
    return handle(request, env, ctx) as Promise<Response>;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
