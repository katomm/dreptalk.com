// @vitest-environment happy-dom
// DOM tests for the proposer picker in the composer: it renders only when the
// page hands over a real choice, and the choice travels as actAs.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import Composer from './Composer.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TWO = {
  proposers: [
    { proposerStakeAddr: 'stake1aaa', label: 'Org A' },
    { proposerStakeAddr: 'stake1bbb', label: 'Org B' },
  ],
  allowSelf: false,
};

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, slug: 'x', postId: 'p1' }), { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  // The composer reloads or navigates after a successful post.
  vi.stubGlobal('sessionStorage', { setItem: vi.fn(), getItem: vi.fn() });
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>) {
  const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('Composer proposer picker', () => {
  it('renders no picker without options', () => {
    render(<Composer mode="topic" categorySlug="proposal-drafts" />);
    expect(screen.queryByLabelText('Post as')).toBeNull();
  });

  it('renders no picker for a single proposer and no own role', () => {
    render(
      <Composer
        mode="topic"
        categorySlug="proposal-drafts"
        mandateOptions={{ proposers: [TWO.proposers[0]], allowSelf: false }}
      />,
    );
    expect(screen.queryByLabelText('Post as')).toBeNull();
  });

  it('offers the proposers, first one selected, and as yourself only with a writer role', () => {
    render(<Composer mode="topic" categorySlug="proposal-drafts" mandateOptions={{ ...TWO, allowSelf: true }} />);
    const select = screen.getByLabelText('Post as') as unknown as HTMLSelectElement;
    expect(select.value).toBe('stake1aaa');
    expect(Array.from(select.options).map((o) => o.text)).toEqual(['Org A', 'Org B', 'As yourself']);
  });

  it('sends the chosen proposer as actAs for a new topic', async () => {
    const fetchMock = stubFetch();
    render(<Composer mode="topic" categorySlug="proposal-drafts" mandateOptions={TWO} />);
    fireEvent.change(screen.getByLabelText('Post as'), { target: { value: 'stake1bbb' } });
    fireEvent.change(document.getElementById('composer-title') as HTMLInputElement, { target: { value: 'My draft' } });
    fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'Body text' } });
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock).actAs).toEqual({ proposerStakeAddr: 'stake1bbb' });
  });

  it('sends self when as yourself is chosen, for a reply', async () => {
    const fetchMock = stubFetch();
    render(<Composer mode="post" topicId="t1" categorySlug="proposal-drafts" mandateOptions={{ ...TWO, allowSelf: true }} />);
    fireEvent.change(screen.getByLabelText('Post as'), { target: { value: 'self' } });
    fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'A reply' } });
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock).actAs).toBe('self');
  });

  it('sends no actAs without a picker', async () => {
    const fetchMock = stubFetch();
    render(<Composer mode="post" topicId="t1" categorySlug="governance-actions" />);
    fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, { target: { value: 'A reply' } });
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect('actAs' in sentBody(fetchMock)).toBe(false);
  });
});
