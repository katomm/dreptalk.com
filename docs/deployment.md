# Deployment

Production runs on mainnet at [dreptalk.com](https://dreptalk.com) (`www` redirects to the apex). A full preprod mirror runs at [preprod.dreptalk.com](https://preprod.dreptalk.com) for testing governance flows against the preprod testnet. The mirror is a separate worker (`dreptalk-com-preprod`) with its own D1 database and KV namespaces so preprod DReps, governance and logins never mix with mainnet. It also runs its own copy of the gov-sync cron worker (`dreptalk-gov-sync-preprod`) against preprod Koios. Because it sets `CARDANO_NETWORK=preprod`, the middleware tags every response `X-Robots-Tag: noindex, nofollow` so the mirror stays out of search indexes.

The app preprod config is not a `wrangler.toml` environment: the `@astrojs/cloudflare` adapter regenerates the deploy config from the top level only and drops `[env.*]` blocks, so `scripts/preprod-config.mjs` derives it from the adapter's build output instead. The gov-sync worker has no adapter, so it uses a normal `[env.preprod]` block.

Deploys are split per worker and environment so a failed step stays contained and any single target can be re-run on its own: `npm run deploy:app` and `npm run deploy:sync` ship the mainnet app and cron worker, `npm run deploy:app:preprod` and `npm run deploy:sync:preprod` ship their preprod mirrors, `npm run deploy:mainnet` and `npm run deploy:preprod` group the two workers per environment, and `npm run deploy` (alias for `npm run deploy:all`) ships all four. Both environments build from the same source; only `CARDANO_NETWORK`, the bindings and the route differ. Custom domains and their TLS certificates are provisioned automatically from the `dreptalk.com` zone on deploy. Mainnet schema changes are applied with `wrangler d1 migrations apply DB --remote`; the preprod database is targeted through the gov-sync env with `wrangler d1 migrations apply DB -c workers/gov-sync/wrangler.toml --env preprod --remote`.

The preprod workers need the same config as mainnet, set once after their first deploy. The legal plain-text vars (`LEGAL_*`, `PRIVACY_CONTACT_EMAIL`) go on the app worker as Worker vars. `KOIOS_API_KEY` is a secret, not a var, and is set per worker with `wrangler secret put`; the same Koios token works on every network (it is tied to the account tier, not the network), so reuse the mainnet token. A free Koios account is enough, but a Pro key is recommended for production: the cron worker's six-hourly DRep enumeration is rate-limit heavy, and the very first sync from an empty database is the heaviest. It is optional but recommended for preprod too:

```sh
npx wrangler secret put KOIOS_API_KEY --name dreptalk-com-preprod
npx wrangler secret put KOIOS_API_KEY --name dreptalk-gov-sync-preprod
```

---

See also: [Development](development.md) · [README](../README.md)
