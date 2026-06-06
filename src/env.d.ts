/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

declare namespace App {
  interface Locals {
    /** Authenticated user from the session cookie, or null if unauthenticated. */
    user: { id: string; roles: string[] } | null;
  }
}

// Cloudflare runtime bindings exposed via `import { env } from 'cloudflare:workers'`.
// Adapter 13 / Astro 6 removed `Astro.locals.runtime.env`; `env` is typed against
// the global `Cloudflare.Env` interface, which we augment here.
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    SESSIONS?: KVNamespace;
    NONCES?: KVNamespace;
    CARDANO_NETWORK?: string;
    [key: string]: unknown;
  }
}
