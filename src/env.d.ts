/// <reference path="../.astro/types.d.ts" />
/// <reference types="@cloudflare/workers-types" />

declare namespace App {
  interface Locals {
    /**
     * Authenticated user from the session cookie, or null if unauthenticated.
     * drepId is the user's own drep_id cached on the session (null = no drep_id;
     * undefined = legacy session predating the field, resolve via getSelfDrepId).
     * grantId/actsFor are set when the session was minted under a co-proposer
     * grant: grantId identifies the grant, actsFor identifies the principal
     * (the user who created the grant) the request acts on behalf of.
     */
    user: {
      id: string;
      roles: string[];
      drepId?: string | null;
      grantId?: string | null;
      actsFor?: { userId: string; stakeAddr: string } | null;
    } | null;
    /**
     * Request-scoped memo of the signed-in header data (identity + unread
     * count); set and read via loadSessionHeader, never directly.
     */
    sessionHeader?: Promise<[import('./lib/forum/author.js').AuthorDescriptor, number]>;
  }
}

// Cloudflare runtime bindings exposed via `import { env } from 'cloudflare:workers'`.
// Adapter 13 / Astro 6 removed `Astro.locals.runtime.env`; `env` is typed against
// the global `Cloudflare.Env` interface, which we augment here.
//
// Every key the app reads is declared explicitly and there is deliberately no
// index signature, so a typo'd or undeclared binding fails the typecheck
// instead of compiling as `unknown`. Members stay optional on purpose: local
// dev and tests run with partial bindings, and the code null-checks each one
// at its point of use (serving a 503 rather than crashing). The workers-test
// env is typed separately (ProvidedEnv in src/lib/test-setup.workers.ts),
// where the bindings the tests provide are required rather than optional.
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    SESSIONS?: KVNamespace;
    RATE_LIMITER?: DurableObjectNamespace<import('./lib/rateLimiterDO.js').RateLimiter>;
    AVATARS?: R2Bucket;
    IMAGES?: import('./lib/dreps/avatarStore.js').ImagesLike;
    /** Static assets binding; the OG image routes read font files through it. */
    ASSETS?: Fetcher;
    CARDANO_NETWORK?: string;
    /** Optional Koios secret for higher rate limits (app proxy + gov-sync). */
    KOIOS_API_KEY?: string;
    /** Moderator allowlist: comma-separated `<stake_addr>:<role>` pairs. */
    MODERATORS?: string;
    VAPID_PUBLIC_KEY?: string;
    /** Secret on the app worker (test pushes) and gov-sync (dispatcher). */
    VAPID_PRIVATE_KEY?: string;
    /** Secret on the app worker (webhook route: replies, test sends) and gov-sync (dispatcher). */
    TELEGRAM_BOT_TOKEN?: string;
    /** Verifies inbound webhook requests actually come from Telegram. */
    TELEGRAM_WEBHOOK_SECRET?: string;
    /** Bot username used to build the t.me deep link, e.g. "DRepTalkBot". */
    TELEGRAM_BOT_USERNAME?: string;
    /** Imprint/legal page contact data, set as vars so the repo stays address-free. */
    LEGAL_OPERATOR_NAME?: string;
    LEGAL_OPERATOR_ADDRESS?: string;
    LEGAL_RESPONSIBLE_PERSON?: string;
    LEGAL_CONTACT_EMAIL?: string;
    LEGAL_PHONE?: string;
    LEGAL_VAT_ID?: string;
  }
}
