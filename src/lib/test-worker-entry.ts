// Minimal Worker entrypoint used ONLY by the vitest-pool-workers project.
//
// The production `main` in wrangler.toml is the adapter's bare-specifier
// entrypoint (`@astrojs/cloudflare/entrypoints/server`), which the test pool
// cannot resolve as a file path. The workers-runtime tests never fetch the SSR
// worker; they import library functions directly and read bindings from
// `cloudflare:test`. This stub satisfies the pool's `main` requirement so it can
// still load the D1/KV bindings and migrations from wrangler.toml.
//
// The RateLimiter Durable Object is re-exported here so the pool registers the
// class for the RATE_LIMITER binding declared in vitest.workers.config.ts.
export { RateLimiter } from './rateLimiterDO.js';

export default {
  fetch(): Response {
    return new Response('test-worker', { status: 200 });
  },
};
