import { describe, it, expect } from 'vitest';
import { describeMissingBody } from './anchorState.js';
import { META_REEXTRACT_MAX_ATTEMPTS } from './metadata.js';

const base = { anchorUrl: 'ipfs://QmCid/meta.json', anchorStatus: 'fetch-failed', metaAttempts: 0 };

describe('describeMissingBody', () => {
  it('reads a fresh unreachable anchor as still syncing', () => {
    const state = describeMissingBody(base);
    expect(state.syncing).toBe(true);
    expect(state.message).toContain('still');
  });

  it('keeps reporting syncing while the backfill has attempts left', () => {
    expect(describeMissingBody({ ...base, metaAttempts: META_REEXTRACT_MAX_ATTEMPTS - 1 }).syncing).toBe(true);
  });

  it('switches to the failure wording once the retry budget is spent', () => {
    const state = describeMissingBody({ ...base, metaAttempts: META_REEXTRACT_MAX_ATTEMPTS });
    expect(state.syncing).toBe(false);
    expect(state.message).toContain('could not be retrieved');
  });

  it('treats an unsupported anchor scheme as final, never as syncing', () => {
    const state = describeMissingBody({ anchorUrl: 'ftp://x/m.json', anchorStatus: 'unsupported-url', metaAttempts: 0 });
    expect(state.syncing).toBe(false);
  });

  it('treats a hash mismatch as final: the document was read, it just does not match', () => {
    const state = describeMissingBody({ ...base, anchorStatus: 'hash-mismatch' });
    expect(state.syncing).toBe(false);
    expect(state.message).toContain('on-chain hash');
  });

  it('names a genuinely empty document rather than blaming the fetch', () => {
    const state = describeMissingBody({ ...base, anchorStatus: 'ok' });
    expect(state.syncing).toBe(false);
    expect(state.message).toContain('no summary or rationale');
  });

  it('says so when the proposer attached no document at all', () => {
    const state = describeMissingBody({ anchorUrl: null, anchorStatus: 'no-anchor', metaAttempts: 0 });
    expect(state.syncing).toBe(false);
    expect(state.message).toContain('did not attach');
  });
});
