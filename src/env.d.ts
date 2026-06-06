/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

declare namespace App {
  interface Locals {
    /** Authenticated user from the session cookie, or null if unauthenticated. */
    user: { id: string; roles: string[] } | null;
    runtime?: {
      env?: {
        DB?: D1Database;
        SESSIONS?: KVNamespace;
        NONCES?: KVNamespace;
        CARDANO_NETWORK?: string;
        [key: string]: unknown;
      };
    };
  }
}
