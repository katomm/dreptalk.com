// Migration 0118 resets the retry budget of IPFS anchors given up before the
// dedicated gateway existed. The suite setup has already applied it to an empty
// schema, so this test seeds rows and replays the migration's own statements,
// taken from the same migration payload the setup applies.
import { describe, it, expect } from 'vitest';
import { env, type D1Migration } from 'cloudflare:test';

const MIGRATION = '0118_redrain_ipfs_anchors.sql';

function redrainQueries(): string[] {
  const migrations = JSON.parse(env.TEST_D1_MIGRATIONS) as D1Migration[];
  const found = migrations.find((m) => m.name === MIGRATION);
  if (!found) throw new Error(`${MIGRATION} not in the migration payload`);
  return found.queries;
}

async function seedAction(id: string, anchorUrl: string, anchorStatus: string, metaAttempts: number) {
  await env.DB.prepare(
    `INSERT INTO governance_actions (id, type, anchor_url, anchor_status, meta_attempts, status, created_at, last_synced_at)
     VALUES (?, 'InfoAction', ?, ?, ?, 'open', 0, 0)`,
  )
    .bind(id, anchorUrl, anchorStatus, metaAttempts)
    .run();
}

async function seedRationale(voterId: string, anchorUrl: string, status: string, attempts: number) {
  await env.DB.prepare(
    `INSERT INTO action_rationale (ga_id, voter_id, body_html, source, anchor_url, status, attempts, created_at, fetched_at)
     VALUES ('gaRedrain#0', ?, NULL, 'onchain', ?, ?, ?, 0, 0)`,
  )
    .bind(voterId, anchorUrl, status, attempts)
    .run();
}

async function actionAttempts(): Promise<Record<string, number>> {
  const rows = await env.DB.prepare('SELECT id, meta_attempts FROM governance_actions ORDER BY id').all<{
    id: string;
    meta_attempts: number;
  }>();
  return Object.fromEntries(rows.results.map((r) => [r.id, r.meta_attempts]));
}

async function rationaleAttempts(): Promise<Record<string, number>> {
  const rows = await env.DB.prepare('SELECT voter_id, attempts FROM action_rationale ORDER BY voter_id').all<{
    voter_id: string;
    attempts: number;
  }>();
  return Object.fromEntries(rows.results.map((r) => [r.voter_id, r.attempts]));
}

describe('migration 0118 redrain of ipfs anchors', () => {
  it('resets given-up ipfs anchors and leaves every other row alone', async () => {
    await seedAction('ipfsFailed', 'ipfs://QmA', 'fetch-failed', 10);
    await seedAction('ipfsBadType', 'ipfs://QmB', 'bad-content-type', 10);
    await seedAction('gatewayPath', 'https://gateway.example/ipfs/QmC', 'fetch-failed', 4);
    await seedAction('ipfsOk', 'ipfs://QmD', 'ok', 3);
    await seedAction('ipfsMismatch', 'ipfs://QmE', 'hash-mismatch', 10);
    await seedAction('httpsPlain', 'https://example.com/meta.json', 'fetch-failed', 10);

    await seedRationale('ratIpfs', 'ipfs://QmF', 'failed', 5);
    await seedRationale('ratGateway', 'https://gateway.example/ipfs/QmG', 'failed', 5);
    await seedRationale('ratOk', 'ipfs://QmH', 'ok', 1);
    await seedRationale('ratEmpty', 'ipfs://QmI', 'empty', 1);
    await seedRationale('ratHttps', 'https://example.com/r.json', 'failed', 5);

    await env.DB.batch(redrainQueries().map((q) => env.DB.prepare(q)));

    expect(await actionAttempts()).toEqual({
      gatewayPath: 0,
      httpsPlain: 10,
      ipfsBadType: 0,
      ipfsFailed: 0,
      ipfsMismatch: 10,
      ipfsOk: 3,
    });
    expect(await rationaleAttempts()).toEqual({
      ratEmpty: 1,
      ratGateway: 0,
      ratHttps: 5,
      ratIpfs: 0,
      ratOk: 1,
    });
  });
});
