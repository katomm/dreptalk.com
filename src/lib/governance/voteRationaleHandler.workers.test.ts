import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleVoteRationale } from './voteRationaleHandler.js';
import { getVoteRationaleBody } from '@/lib/db/voteRationale.js';

const drepId = 'drep1' + 'q'.repeat(50);
const gaId = 'a'.repeat(64) + '#0';

describe('handleVoteRationale', () => {
  it('hosts the document and returns a content-addressed url + hash', async () => {
    const res = await handleVoteRationale({
      body: { drepId, gaId, rationale: 'Because it strengthens the treasury.' },
      db: env.DB,
      origin: 'https://dreptalk.com',
      now: 1_700_000_000_000,
    });
    expect(res.status).toBe(200);
    const { url, hash } = res.json as { url: string; hash: string };
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(url).toBe(`https://dreptalk.com/vote-rationale/${hash}.json`);
    const stored = await getVoteRationaleBody(env.DB, hash);
    expect(stored && JSON.parse(stored).body.comment).toBe('Because it strengthens the treasury.');
  });

  it('rejects an empty rationale and a bad drep id', async () => {
    const bad = await handleVoteRationale({
      body: { drepId: 'nope', gaId, rationale: 'x' },
      db: env.DB, origin: 'https://dreptalk.com', now: 1,
    });
    expect(bad.status).toBe(400);
  });
});
