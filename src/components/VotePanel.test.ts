// Unit tests for the submitVote orchestration exported from VotePanel.tsx.
// React rendering is not tested here; only the pure submit logic is exercised,
// with hostRationale, castVote, and recordVote replaced by mocks.
import { describe, it, expect, vi } from 'vitest';
import { submitVote } from './VotePanel.js';

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
