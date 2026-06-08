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
cfg.vars = { ...(cfg.vars ?? {}), CARDANO_NETWORK: 'preprod' };
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
  { binding: 'NONCES', id: '00f38138e4dd4325b7afb2b74dacf355' },
];

// This is a standalone config, not a wrangler environment: drop the env
// metadata so the derived name is used verbatim (no legacy "-preprod" suffix).
delete cfg.definedEnvironments;
cfg.legacy_env = false;

writeFileSync(OUT, JSON.stringify(cfg, null, 2));
console.log(`Wrote ${OUT} (worker ${cfg.name}, db ${cfg.d1_databases[0].database_name})`);
