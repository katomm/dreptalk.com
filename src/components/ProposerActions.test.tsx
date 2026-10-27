// @vitest-environment happy-dom
// DOM tests for the proposer's action list on /home: the search box, the
// finished group, and the per-row invite control. The environment is
// file-scoped on purpose: the node and workers test projects keep their own.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ProposerActions, { type ProposerActionView } from './ProposerActions.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function txId(n: number): string {
  return `${n.toString(16).padStart(64, '0')}#0`;
}

function row(n: number, over: Partial<ProposerActionView> = {}): ProposerActionView {
  return {
    id: txId(n),
    proposalId: `gov_action1row${n}`,
    title: `Action ${n}`,
    type: 'InfoAction',
    status: 'active',
    topicSlug: `action-${n}`,
    open: true,
    authors: [],
    pending: [],
    active: [],
    ...over,
  };
}

function rows(count: number): ProposerActionView[] {
  return Array.from({ length: count }, (_, i) => row(i + 1));
}

describe('ProposerActions search', () => {
  it('shows no search box below 10 rows', () => {
    render(<ProposerActions actions={rows(9)} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('shows a search box from 10 rows', () => {
    render(<ProposerActions actions={rows(10)} />);
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('filters by title', () => {
    render(<ProposerActions actions={[...rows(9), row(42, { title: 'Treasury for Trivolve' })]} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'trivolve' } });
    expect(screen.getByText('Treasury for Trivolve')).toBeTruthy();
    expect(screen.queryByText('Action 1')).toBeNull();
  });

  it('filters by <tx>#<idx> and by gov_action1 id', () => {
    render(<ProposerActions actions={rows(12)} />);
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: txId(7) } });
    expect(screen.getByText('Action 7')).toBeTruthy();
    expect(screen.queryByText('Action 8')).toBeNull();

    fireEvent.change(box, { target: { value: 'gov_action1row11' } });
    expect(screen.getByText('Action 11')).toBeTruthy();
    expect(screen.queryByText('Action 7')).toBeNull();
  });

  it('includes the collapsed finished rows in the filter', () => {
    const list = [...rows(10), row(77, { title: 'Old enacted thing', status: 'enacted', open: false })];
    render(<ProposerActions actions={list} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'enacted thing' } });
    expect(screen.getByText('Old enacted thing')).toBeTruthy();
    expect(screen.queryByText('Action 1')).toBeNull();
  });

  it('falls back to type and short id for an untitled action', () => {
    render(<ProposerActions actions={[row(5, { title: null })]} />);
    expect(screen.getByText('Info Action 000000…00005#0')).toBeTruthy();
  });
});

describe('ProposerActions invite control', () => {
  it('disables invite with a reason when the action has no thread yet', () => {
    render(<ProposerActions actions={[row(1, { topicSlug: null })]} />);
    const btn = screen.getByRole('button', { name: 'Invite co-proposer' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/no discussion thread yet/i)).toBeTruthy();
  });

  it('renders no invite control on a finished action', () => {
    render(<ProposerActions actions={[row(1, { open: false, status: 'expired' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show finished actions (1)' }));
    expect(screen.getByText('Action 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite co-proposer' })).toBeNull();
  });

  it('still lists co-proposers with Remove on a finished action', () => {
    render(
      <ProposerActions
        actions={[
          row(1, {
            open: false,
            status: 'ratified',
            active: [{ grantId: 'g1', coName: 'Ravi', coStakeAddr: null, since: 1_700_000_000, teamLabel: 'Trivolve Tech' }],
          }),
        ]}
      />,
    );
    // Finished actions sit in a collapsed group.
    expect(screen.queryByText('Ravi')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show finished actions (1)' }));
    expect(screen.getByText('Ravi')).toBeTruthy();
    expect(screen.getByText(/Trivolve Tech/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('disables invite at the per-action limit', () => {
    const pending = Array.from({ length: 4 }, (_, i) => ({
      grantId: `p${i}`,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_600_000,
      teamLabel: null,
    }));
    render(<ProposerActions actions={[row(1, { pending })]} />);
    const btn = screen.getByRole('button', { name: 'Invite co-proposer' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/limit of 4/i)).toBeTruthy();
  });

  it('sends no teamLabel when "No team name" is picked', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ inviteUrl: '/co-proposer/redeem?code=abc', expiresAt: 1_700_600_000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ProposerActions actions={[row(1, { authors: ['Trivolve Tech', 'Cardano Foundation'] })]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Invite co-proposer' }));
    const select = screen.getByRole('combobox');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['No team name', 'Trivolve Tech', 'Cardano Foundation']);
    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/co-proposer/invite');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ govActionId: txId(1) });
    expect('teamLabel' in body).toBe(false);
    await waitFor(() => expect(screen.getByText(/co-proposer\/redeem\?code=abc/)).toBeTruthy());
  });

  it('sends the picked team name', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ inviteUrl: '/co-proposer/redeem?code=xyz', expiresAt: 1_700_600_000 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ProposerActions actions={[row(1, { authors: ['Trivolve Tech'] })]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Invite co-proposer' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Trivolve Tech' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ govActionId: txId(1), teamLabel: 'Trivolve Tech' });
  });

  it('creates the invite in one click when the action has no authors', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ inviteUrl: '/co-proposer/redeem?code=one', expiresAt: 1_700_600_000 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ProposerActions actions={[row(1)]} />);
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Invite co-proposer' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ govActionId: txId(1) });
  });
});
