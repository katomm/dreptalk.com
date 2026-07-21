/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

declare namespace App {
  interface Locals {
    /**
     * Authenticated user from the session cookie, or null if unauthenticated.
     * drepId is the user's own drep_id cached on the session (null = no drep_id;
     * undefined = legacy session predating the field, resolve via getSelfDrepId).
     */
    user: { id: string; roles: string[]; drepId?: string | null } | null;
  }
}

// Cloudflare runtime bindings exposed via `import { env } from 'cloudflare:workers'`.
// Adapter 13 / Astro 6 removed `Astro.locals.runtime.env`; `env` is typed against
// the global `Cloudflare.Env` interface, which we augment here.
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    SESSIONS?: KVNamespace;
    RATE_LIMITER?: DurableObjectNamespace<import('./lib/rateLimiterDO.js').RateLimiter>;
    AVATARS?: R2Bucket;
    IMAGES?: import('./lib/dreps/avatarStore.js').ImagesLike;
    CARDANO_NETWORK?: string;
    VAPID_PUBLIC_KEY?: string;
    /** Secret on the app worker (test pushes) and gov-sync (dispatcher). */
    VAPID_PRIVATE_KEY?: string;
    [key: string]: unknown;
  }
}
