// Unit tests for the submitVote orchestration exported from VotePanel.tsx.
// React rendering is not tested here; only the pure submit logic is exercised,
// with hostRationale, castVote, and recordVote replaced by mocks.
import { describe, it, expect, vi } from 'vitest';
import { submitVote, expiredActionMessage } from './VotePanel.js';

describe('submitVote orchestration', () => {
  it('hosts rationale, casts, then records (rationale path)', async () => {
    const calls: string[] = [];
    const deps = {
      hostRationale: vi.fn(async () => { calls.push('host'); return { url: 'u', hash: 'h' }; }),
      castVote: vi.fn(async () => { calls.push('cast'); return { txHash: 'tx' }; }),
      recordVote: vi.fn(async () => { calls.push('record'); }),
    };
    const res = await submitVote(deps, {
      gaId: `${'a'.repeat(64)}#0`,
      vote: 'yes',
      rationaleText: 'why',
      drepKeyHash: new Uint8Array(28),
      network: 'preprod',
      origin: 'https://x',
    });
    expect(calls).toEqual(['host', 'cast', 'record']);
    expect(res.txHash).toBe('tx');
    expect(deps.castVote).toHaveBeenCalledWith(expect.objectContaining({ anchorUrl: 'u', anchorHashHex: 'h' }));
  });

  it('calls onRationaleHosted with the anchor on the rationale path', async () => {
    const onRationaleHosted = vi.fn();
    const deps = {
      hostRationale: vi.fn(async () => ({ url: 'https://anchor.example/r.json', hash: 'abc123' })),
      castVote: vi.fn(async () => ({ txHash: 'tx2' })),
      recordVote: vi.fn(async () => {}),
      onRationaleHosted,
    };
    await submitVote(deps, {
      gaId: `${'a'.repeat(64)}#0`,
      vote: 'yes',
      rationaleText: 'rationale text',
      drepKeyHash: new Uint8Array(28),
      network: 'preprod',
      origin: 'https://x',
    });
    expect(onRationaleHosted).toHaveBeenCalledOnce();
    expect(onRationaleHosted).toHaveBeenCalledWith({ url: 'https://anchor.example/r.json', hash: 'abc123' });
  });

  it('skips hosting when there is no rationale', async () => {
    const deps = {
      hostRationale: vi.fn(),
      castVote: vi.fn(async () => ({ txHash: 'tx' })),
      recordVote: vi.fn(async () => {}),
    };
    await submitVote(deps, {
      gaId: `${'a'.repeat(64)}#0`,
      vote: 'no',
      rationaleText: '',
      drepKeyHash: new Uint8Array(28),
      network: 'preprod',
      origin: 'https://x',
    });
    expect(deps.hostRationale).not.toHaveBeenCalled();
  });

  it('does NOT call onRationaleHosted when there is no rationale', async () => {
    const onRationaleHosted = vi.fn();
    const deps = {
      hostRationale: vi.fn(),
      castVote: vi.fn(async () => ({ txHash: 'tx' })),
      recordVote: vi.fn(async () => {}),
      onRationaleHosted,
    };
    await submitVote(deps, {
      gaId: `${'a'.repeat(64)}#0`,
      vote: 'abstain',
      rationaleText: '   ',
      drepKeyHash: new Uint8Array(28),
      network: 'preprod',
      origin: 'https://x',
    });
    expect(onRationaleHosted).not.toHaveBeenCalled();
  });
});

describe('expiredActionMessage', () => {
  it('returns a friendly message when the error mentions voting + expired', () => {
    const result = expiredActionMessage(new Error('The voting period has expired for this proposal'));
    expect(result).toBe('This governance action is no longer accepting votes (it may have expired). Please refresh the page.');
  });

  it('returns a friendly message for gov action not active ledger error', () => {
    const result = expiredActionMessage(new Error('Error: gov action not active'));
    expect(result).toBe('This governance action is no longer accepting votes (it may have expired). Please refresh the page.');
  });

  it('returns a friendly message for governance action not active ledger error', () => {
    const result = expiredActionMessage(new Error('Rejected: Governance action not active'));
    expect(result).toBe('This governance action is no longer accepting votes (it may have expired). Please refresh the page.');
  });

  it('returns a friendly message for expired proposal', () => {
    const result = expiredActionMessage(new Error('expired proposal'));
    expect(result).toBe('This governance action is no longer accepting votes (it may have expired). Please refresh the page.');
  });

  it('returns null for an unrelated error', () => {
    const result = expiredActionMessage(new Error('insufficient funds'));
    expect(result).toBeNull();
  });

  it('returns null for a generic connection error', () => {
    const result = expiredActionMessage(new Error('fetch failed: connection refused'));
    expect(result).toBeNull();
  });
});
