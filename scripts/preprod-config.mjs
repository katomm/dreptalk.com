// Derives the preprod app worker config from the adapter's generated config.
//
// The @astrojs/cloudflare adapter writes the deploy config to
// dist/server/wrangler.json from the top level of wrangler.toml only; it drops
// any [env.*] blocks. That makes `wrangler deploy --env preprod` ship the
// preprod worker with the mainnet D1/KV bindings, which would let preprod write
// into the mainnet database. To avoid that we reuse the exact same build output
// and only swap the bindings that must differ for preprod.
//
// Run after `astro build`, then deploy with:
//   wrangler deploy -c dist/server/wrangler.preprod.json
import { readFileSync, writeFileSync } from 'node:fs';

const GENERATED = 'dist/server/wrangler.json';
const OUT = 'dist/server/wrangler.preprod.json';

const cfg = JSON.parse(readFileSync(GENERATED, 'utf8'));

cfg.name = 'dreptalk-com-preprod';
// Other [vars] from the base config carry through unchanged via the spread.
// CARDANO_NETWORK selects the network, and VAPID_PUBLIC_KEY must be the
// preprod keypair's public half (the base config carries the mainnet one).
// Both, and TESSERA_BACKEND_URL, are held equal to [env.preprod.vars] in
// workers/gov-sync/wrangler.toml by src/lib/deployVars.test.ts.
cfg.vars = {
  ...(cfg.vars ?? {}),
  CARDANO_NETWORK: 'preprod',
  VAPID_PUBLIC_KEY: 'BP8lsNXkOYQipYvkb5iBFeXOlDdkcDrlC7Dqbgw3e1bNd9UhgF3KdbpjHCwEMyhtExwc06YlzwzaUo_pCK8VXJ0',
  // Preprod bot username for the notification deep link (mainnet bot differs).
  TELEGRAM_BOT_USERNAME: 'DRepTalkPreprodBot',
  // Feature switch for CIP-179 surveys: the app only checks presence (without
  // it the surveys category does not exist); gov-sync is the one caller of
  // the URL.
  TESSERA_BACKEND_URL: 'https://tessera-backend-preprod.matthieu-pizenberg.workers.dev',
  // Deep-link target on survey cards ("open in Tessera"); display-only.
  TESSERA_APP_URL: 'https://tessera-preprod.matthieu-pizenberg.workers.dev',
};
cfg.routes = [{ pattern: 'preprod.dreptalk.com', custom_domain: true }];
cfg.d1_databases = [
  {
    binding: 'DB',
    database_name: 'dreptalk-preprod',
    database_id: 'adf2310b-b1c1-415a-b900-28dd56277cbb',
    migrations_dir: 'migrations',
  },
];
cfg.kv_namespaces = [
  { binding: 'SESSIONS', id: 'be3d778c8ee3431dadb0aecb8275ed61' },
];
cfg.r2_buckets = [{ binding: 'AVATARS', bucket_name: 'dreptalk-avatars-preprod' }];

// The Images binding is account-level (no per-network resource), so preprod
// reuses the same binding. Set it explicitly in case the adapter drops it.
cfg.images = { binding: 'IMAGES' };

// This is a standalone config, not a wrangler environment: drop the env
// metadata so the derived name is used verbatim (no legacy "-preprod" suffix).
// The worker is deployed by name via `-c`, never `--env`, so no env handling is
// needed. `legacy_env` must NOT be set: wrangler 4 removed service environments
// and now rejects the field outright, which broke every preprod deploy.
delete cfg.definedEnvironments;

writeFileSync(OUT, JSON.stringify(cfg, null, 2));
console.log(`Wrote ${OUT} (worker ${cfg.name}, db ${cfg.d1_databases[0].database_name})`);
