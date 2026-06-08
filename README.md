# DRepTalk

Wallet-authenticated discussion forum for Cardano governance, running at [dreptalk.com](https://dreptalk.com).

Incoming on-chain Governance Actions automatically open a thread, and DReps, SPOs, CC members, and proposers discuss them next to the live on-chain vote data. Reading is public; writing is gated to those on-chain roles, each proven by a wallet signature (no custody of keys, signature-based login).

The aim is a calmer, accountable home for governance discussion, away from the drama of social media.

## Stack

Astro (SSR) on Cloudflare Workers, with D1 and KV. A standalone cron worker ingests governance actions. Chain data via Koios, used anonymously by default; set `KOIOS_API_KEY` to send an authenticated key for higher rate limits. Defaults to mainnet; set `CARDANO_NETWORK=preprod` for local and preview.

Moderation is community-first: any on-chain writer (DRep, SPO, CC member, or proposer) can flag a post, and a post is hidden behind a placeholder once three distinct writers have flagged it. Every writer is a wallet-verified governance participant, and registering as a DRep locks a refundable 500 ADA deposit, so coordinated abuse is expensive and this lightweight check is expected to be enough in early operation; the post author and moderators can still read a hidden post. Moderators and admins can be granted by stake address through the `MODERATORS` env value (comma-separated `stakeAddress` or `stakeAddress:role`, role `admin` or `moderator`), empty by default: they sign in with the normal stake-key wallet flow, and the allowlist only adds the moderation role.

On-chain values (governance tallies and status, DRep profiles, per-post vote badges) are synced on crons and are cached, not live; every place they appear shows an "as of" time. The exact cadences live in one place, `src/lib/freshness.ts`, and are published at `/help/data-freshness`.

The legal pages (`/imprint`, `/privacy`) read the operator and contact details from env so they stay out of the repository: `LEGAL_OPERATOR_NAME`, `LEGAL_OPERATOR_ADDRESS` (separate lines with `|`), `LEGAL_CONTACT_EMAIL`, optional `LEGAL_RESPONSIBLE_PERSON`, `LEGAL_PHONE`, `LEGAL_VAT_ID`. Set them in `.dev.vars` locally and as Worker vars in production.

## Local development

Requires Node 20+. Local and preview run against the Cardano preprod testnet; set `CARDANO_NETWORK=preprod` in `.dev.vars`.

- `npm install`
- `npm run dev`: app dev server (Astro, with HMR)
- `npm test`: unit and integration tests
- `npm run typecheck`: type check
- `npm run preview`: production build served via `wrangler dev`

### Running a governance sync locally

On-chain data is ingested by a standalone Cloudflare cron worker at `workers/gov-sync` that shares the app's D1 database. It has three cron triggers, and the worker dispatches on the cron expression, so to run a specific sync locally you pass that expression to `/__scheduled`. Start the worker once, then trigger the run you need:

```sh
npm run sync:dev                                       # terminal 1: start the worker (wrangler dev, scheduled enabled)

# terminal 2: trigger a single run. Keep the * inside quotes so the shell does not expand them.
curl "http://localhost:8787/__scheduled"                       # governance actions + tallies (default */15 cron)
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"        # per-post DRep vote lists (hourly cron)
curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"      # DRep profiles + voting power (6-hourly cron)
```

It polls Koios (preprod locally, per `CARDANO_NETWORK`) and writes to D1. Stake Participation on the governance overview needs the DRep run (it fills `dreps.voting_power`); the voted share also needs the vote run. The cron expressions mirror `src/lib/freshness.ts`.

## Deployment

Production runs on mainnet at [dreptalk.com](https://dreptalk.com) (`www` redirects to the apex). A full preprod mirror runs at [preprod.dreptalk.com](https://preprod.dreptalk.com) for testing governance flows against the preprod testnet. The mirror is a separate worker (`dreptalk-com-preprod`) with its own D1 database and KV namespaces so preprod DReps, governance and logins never mix with mainnet. It also runs its own copy of the gov-sync cron worker (`dreptalk-gov-sync-preprod`) against preprod Koios. Because it sets `CARDANO_NETWORK=preprod`, the middleware tags every response `X-Robots-Tag: noindex, nofollow` so the mirror stays out of search indexes.

The app preprod config is not a `wrangler.toml` environment: the `@astrojs/cloudflare` adapter regenerates the deploy config from the top level only and drops `[env.*]` blocks, so `scripts/preprod-config.mjs` derives it from the adapter's build output instead. The gov-sync worker has no adapter, so it uses a normal `[env.preprod]` block.

`npm run deploy` ships all four workers in one step: the app and the cron worker, each to mainnet and to preprod. Both environments build from the same source; only `CARDANO_NETWORK`, the bindings and the route differ. Custom domains and their TLS certificates are provisioned automatically from the `dreptalk.com` zone on deploy. Mainnet schema changes are applied with `wrangler d1 migrations apply DB --remote`; the preprod database is targeted through the gov-sync env with `wrangler d1 migrations apply DB -c workers/gov-sync/wrangler.toml --env preprod --remote`.

The preprod workers need the same config as mainnet, set once after their first deploy. The legal plain-text vars (`LEGAL_*`, `PRIVACY_CONTACT_EMAIL`) go on the app worker as Worker vars. `KOIOS_API_KEY` is a secret, not a var, and is set per worker with `wrangler secret put`; the same Koios token works on every network (it is tied to the account tier, not the network), so reuse the mainnet token. It is optional but recommended for preprod, mainly for the cron worker, whose six-hourly DRep enumeration is rate-limit heavy:

```sh
npx wrangler secret put KOIOS_API_KEY --name dreptalk-com-preprod
npx wrangler secret put KOIOS_API_KEY --name dreptalk-gov-sync-preprod
```

## Status

Early development.

## Feedback

Bugs and feature requests: open a [GitHub issue](https://github.com/katomm/dreptalk.com/issues/new).

## License

Apache 2.0.
