// @vitest-environment happy-dom
// More DOM tests for the submit island, split off SubmitGovAction.dom.test.tsx
// so vitest runs them in parallel. Why these tests exist is explained there.
// The environment is file-scoped on purpose: the node and workers test
// projects keep their own environments.
//
// The shared mocks and helpers live in __fixtures__/submitGovActionHarness.ts.
// This file: publishing, author signing, draft links and the restore banner,
// the review modal, the success screen and the reload-safe context.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import SubmitGovAction from './SubmitGovAction.js';
import { loadGovActionDraft } from '@/lib/governance/govActionDraft.js';
import {
  useSubmitGovActionHarness,
  SLOW,
  submitGovActionMock,
  type CapturedStatusPoll,
  startStatusPollingMock,
  deferred,
  DRAFT_KEY,
  DISPLAY_NAME,
  COMMITTEE_CONTEXT,
  NAMED_COMMITTEE_CONTEXT,
  EMPTY_COMMITTEE_CONTEXT,
  MALFORMED_MEMBER,
  MALFORMED_COMMITTEE_CONTEXT,
  jsonResponse,
  WITNESS_SIGNATURE,
  WITNESS_KEY,
  installFetchMock,
  installWalletMock,
  connect,
  signButton,
  fillMetadata,
  fillCommitteePanel,
  mocks,
} from './__fixtures__/submitGovActionHarness.js';

vi.mock('@/lib/governance/govActionTx.js', async () => (await import('./__fixtures__/submitGovActionHarness.js')).govActionTxMock());
vi.mock('@/lib/governance/successPolling.js', async importOriginal =>
  (await import('./__fixtures__/submitGovActionHarness.js')).successPollingMock(await importOriginal()),
);
vi.mock('@/lib/governance/walletUtxos.js', async importOriginal =>
  (await import('./__fixtures__/submitGovActionHarness.js')).walletUtxosMock(await importOriginal()),
);

describe('SubmitGovAction', () => {
  useSubmitGovActionHarness();

  describe('publishing refused by the pin routes', () => {
    async function submitWith(response: Response) {
      mocks.metadataImpl = () => response;
      installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await connect();
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);
    }

    it.each([
      ['pin_budget_global', /^Publishing is paused for today\. No transaction was signed and no deposit was spent\. Try again after 00:00 UTC\.$/],
      ['pin_budget_ip', /^Publishing from this network connection is paused for today\. No transaction was signed/],
    ])('explains %s after the author signature, without reaching the wallet transaction', async (error, text) => {
      await submitWith(new Response(JSON.stringify({ error }), { status: 429, headers: { 'content-type': 'application/json' } }));
      expect(await screen.findByText(text, {}, SLOW)).toBeTruthy();
      expect(submitGovActionMock).not.toHaveBeenCalled();
    });

    it('says nothing was spent when hosting fails on the server', async () => {
      await submitWith(new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json' } }));
      expect(await screen.findByText(/^Publishing failed on our side\. No transaction was signed and no deposit was spent\./, {}, SLOW)).toBeTruthy();
      expect(submitGovActionMock).not.toHaveBeenCalled();
    });
  });

  describe('sign as author, on by default', () => {
    /** Finds the fetch call to the bare finalize route, never the /prepare one. */
    function metadataCallBody(fetchMock: ReturnType<typeof installFetchMock>): Record<string, unknown> {
      const call = fetchMock.mock.calls.find(([url]) => {
        const s = String(url);
        return s.includes('/api/gov-action/metadata') && !s.includes('/prepare');
      }) as unknown[] | undefined;
      const init = call?.[1] as RequestInit | undefined;
      return JSON.parse(init?.body as string);
    }

    it('reaches submitGovAction with the prefilled name and a wallet witness', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'a'.repeat(64) });
      const fetchMock = installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await connect();

      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gov-action/metadata/prepare')),
      ).toBe(true);
      expect(metadataCallBody(fetchMock).author).toEqual({
        name: DISPLAY_NAME,
        keyHex: WITNESS_KEY,
        signatureHex: WITNESS_SIGNATURE,
      });
    });

    it('reaches submitGovAction with no author once signing is turned off', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'b'.repeat(64) });
      const fetchMock = installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('checkbox', { name: /Sign as author/ }));
      await connect();

      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gov-action/metadata/prepare')),
      ).toBe(false);
      expect('author' in metadataCallBody(fetchMock)).toBe(false);
    });
  });

  describe('Link a Proposal Draft', () => {
    const OPEN_DRAFTS = [
      { slug: 'fund-tooling-a1b2', title: 'Fund tooling', createdAt: 1, own: true },
      { slug: 'other-draft-c3d4', title: 'Someone else draft', createdAt: 1, own: false },
    ];
    const SITE_ORIGIN = 'https://preprod.dreptalk.com';

    it('picking a draft adds it as a reference in the shape the sync matcher recognizes', () => {
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: 'fund-tooling-a1b2' } });

      expect((screen.getByLabelText('Reference 1 label') as HTMLInputElement).value).toBe('Fund tooling');
      expect((screen.getByLabelText('Reference 1 URL') as HTMLInputElement).value).toBe(
        `${SITE_ORIGIN}/t/fund-tooling-a1b2/`,
      );
    });

    it('unlinking removes the reference it added', () => {
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: 'fund-tooling-a1b2' } });
      expect(screen.getByLabelText('Reference 1 label')).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: '' } });

      expect(screen.queryByLabelText('Reference 1 label')).toBeNull();
    });

    // gov-sync's resolver reads the first Proposal Drafts reference of the
    // submitted document, and a closed draft is not excluded from that. A
    // stored draft that carries one ahead of the linked draft would therefore
    // link the wrong thread, with nothing on screen saying so.
    it('puts the linked draft first when a restored draft carries a closed one ahead of it', async () => {
      window.localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          v: 2,
          type: 'InfoAction',
          title: 'A restored proposal',
          abstract: '',
          motivation: '',
          rationale: '',
          signAsAuthor: true,
          authorName: DISPLAY_NAME,
          references: [
            { label: 'A closed draft', uri: `${SITE_ORIGIN}/t/closed-draft-x9/` },
            { label: 'Fund tooling', uri: `${SITE_ORIGIN}/t/fund-tooling-a1b2/` },
          ],
          surveyRef: '',
          panels: {},
          linkedDraftSlug: 'fund-tooling-a1b2',
          savedAt: Date.now(),
        }),
      );
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );
      await screen.findByText(/^Restored your draft from/);

      expect((screen.getByLabelText('Reference 1 URL') as HTMLInputElement).value).toBe(
        `${SITE_ORIGIN}/t/fund-tooling-a1b2/`,
      );
      expect((screen.getByLabelText('Reference 2 URL') as HTMLInputElement).value).toBe(
        `${SITE_ORIGIN}/t/closed-draft-x9/`,
      );
      expect((screen.getByLabelText('Link a Proposal Draft') as HTMLInputElement).value).toBe('fund-tooling-a1b2');
    });

    it('removes a hand-typed reference when the control is set back to "No draft linked"', () => {
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );

      // Typed straight into the references list, never through the control,
      // so nothing is tracked and only the select's own reading connects the
      // two.
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      fireEvent.change(screen.getByLabelText('Reference 1 label'), { target: { value: 'Hand typed' } });
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), {
        target: { value: `${SITE_ORIGIN}/t/fund-tooling-a1b2/` },
      });
      expect((screen.getByLabelText('Link a Proposal Draft') as HTMLInputElement).value).toBe('fund-tooling-a1b2');

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: '' } });

      expect(screen.queryByLabelText('Reference 1 label')).toBeNull();
      expect((screen.getByLabelText('Link a Proposal Draft') as HTMLInputElement).value).toBe('');
    });

    it('replaces a hand-typed reference rather than adding a second one next to it', () => {
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      fireEvent.change(screen.getByLabelText('Reference 1 label'), { target: { value: 'Hand typed' } });
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), {
        target: { value: `${SITE_ORIGIN}/t/fund-tooling-a1b2/` },
      });

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: 'other-draft-c3d4' } });

      expect((screen.getByLabelText('Reference 1 URL') as HTMLInputElement).value).toBe(
        `${SITE_ORIGIN}/t/other-draft-c3d4/`,
      );
      expect(screen.queryByLabelText('Reference 2 URL')).toBeNull();
    });

    it('follows a hand-edited reference URI to a different open draft', () => {
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={OPEN_DRAFTS} siteOrigin={SITE_ORIGIN} />,
      );

      fireEvent.change(screen.getByLabelText('Link a Proposal Draft'), { target: { value: 'fund-tooling-a1b2' } });
      expect((screen.getByLabelText('Link a Proposal Draft') as HTMLInputElement).value).toBe('fund-tooling-a1b2');

      // The same row's URL field, edited by hand to a different open draft's
      // thread, exactly as typing over it would.
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), {
        target: { value: `${SITE_ORIGIN}/t/other-draft-c3d4/` },
      });

      expect((screen.getByLabelText('Link a Proposal Draft') as HTMLInputElement).value).toBe('other-draft-c3d4');
    });
  });

  describe('draft restore banner', () => {
    function storedDraft(overrides: Partial<Record<string, unknown>> = {}): string {
      return JSON.stringify({
        v: 2,
        type: 'InfoAction',
        title: 'Old title',
        abstract: 'Old abstract',
        motivation: 'Old motivation',
        rationale: 'Old rationale',
        signAsAuthor: true,
        authorName: 'Someone else',
        references: [],
        surveyRef: '',
        panels: {},
        ...overrides,
      });
    }

    it('shows the relative time when the stored draft carries a savedAt', async () => {
      window.localStorage.setItem(DRAFT_KEY, storedDraft({ savedAt: Date.now() - 5 * 60 * 1000 }));
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/^Restored your draft from \d+m ago$/);
    });

    it('shows the plain fallback when the stored draft has no savedAt', async () => {
      window.localStorage.setItem(DRAFT_KEY, storedDraft());
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText('Restored your saved draft');
    });

    it('discard empties the form and storage, and a remount shows no banner', async () => {
      window.localStorage.setItem(DRAFT_KEY, storedDraft({ savedAt: Date.now() }));
      const first = render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/^Restored your draft from/);
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Old title');

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

      expect(screen.queryByText(/^Restored your/)).toBeNull();
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('Author name') as HTMLInputElement).value).toBe(DISPLAY_NAME);
      expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)).toBeNull();

      first.unmount();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/Governance action deposit/);
      expect(screen.queryByText(/^Restored your/)).toBeNull();
      // The remount's own restore effect finds nothing (storage was cleared
      // by discard) and dirty stays false, so nothing gets re-saved either.
      expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it('re-saves once a restored draft is edited', async () => {
      window.localStorage.setItem(DRAFT_KEY, storedDraft({ savedAt: Date.now() - 60_000 }));
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/^Restored your draft from/);

      // Restoring cleared dirty, so nothing has been written back yet.
      expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)?.title).toBe('Old title');

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Edited after restore' } });

      // The edit sets dirty back to true, so the persist effect saves again.
      await waitFor(
        () => expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)?.title).toBe('Edited after restore'),
        SLOW,
      );
    });

    it('writes no draft on a fresh visit with nothing edited', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await screen.findByText(/Governance action deposit/);
      expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)).toBeNull();
    });
  });
  // The account behind an enabled CIP-30 handle can change while the form is
  // open: the extension keeps handing back the same api object, but the UTxOs
  // the builder collects and the reward address the refund goes to are then a
  // different account's. The submit re-reads the address and compares it
  // before anything is published.
  describe('wallet account change between connect and submit', () => {
    async function fillAndConnect() {
      fillMetadata();
      await connect();
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      return submit;
    }

    function published(fetchMock: ReturnType<typeof vi.fn>): boolean {
      return fetchMock.mock.calls.some(([url]) => String(url).includes('/api/gov-action/metadata'));
    }

    it('stops before anything is published when the reward address changed, with signing on', async () => {
      const fetchMock = installFetchMock();
      const api = installWalletMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      const submit = await fillAndConnect();

      api.getRewardAddresses.mockResolvedValue(['e0'.concat('d'.repeat(56))]);
      fireEvent.click(submit);

      await screen.findByText('The wallet account changed. Connect the wallet again.', {}, SLOW);
      expect(published(fetchMock)).toBe(false);
      expect(submitGovActionMock).not.toHaveBeenCalled();
      // Back to no wallet, so the readiness list asks for one again.
      await screen.findByText('Connect a wallet');
    });

    it('stops before anything is published when the reward address changed, with signing off', async () => {
      const fetchMock = installFetchMock();
      const api = installWalletMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.click(screen.getByRole('checkbox', { name: /Sign as author/ }));
      const submit = await fillAndConnect();

      api.getRewardAddresses.mockResolvedValue([]);
      fireEvent.click(submit);

      await screen.findByText('The wallet account changed. Connect the wallet again.', {}, SLOW);
      expect(published(fetchMock)).toBe(false);
      expect(submitGovActionMock).not.toHaveBeenCalled();
    });

    it('goes through when the wallet still answers with the same reward address', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'a'.repeat(64) });
      const api = installWalletMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      const submit = await fillAndConnect();

      fireEvent.click(submit);

      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      // Once at connect, once at submit: the second read is the whole point.
      expect(api.getRewardAddresses.mock.calls.length).toBeGreaterThan(1);
      await screen.findByText('Proposal submitted', {}, SLOW);
    });
  });

  it('refuses to discard the draft while a submit is running', async () => {
    // Never resolves, so the island stays in the submitting phase for the rest
    // of the test.
    submitGovActionMock.mockReturnValue(new Promise(() => {}));
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        v: 2,
        type: 'InfoAction',
        title: 'Old title',
        abstract: 'Old abstract',
        motivation: 'Old motivation',
        rationale: 'Old rationale',
        signAsAuthor: true,
        authorName: 'Someone else',
        references: [],
        surveyRef: '',
        panels: {},
        savedAt: Date.now(),
      }),
    );
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    await screen.findByText(/^Restored your draft from/);
    fillMetadata();
    await connect();

    const submit = signButton();
    await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
    fireEvent.click(submit);
    await screen.findByText(/Please approve each wallet prompt/, {}, SLOW);

    const discard = screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement;
    expect(discard.disabled).toBe(true);
    fireEvent.click(discard);

    // The form the running handler is reading is still the form on screen.
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    expect(screen.getByText(/^Restored your draft from/)).toBeTruthy();
  });

  it('renders the committee panel when a member cold hash cannot be encoded as bech32', async () => {
    mocks.committeeContext = MALFORMED_COMMITTEE_CONTEXT;
    render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
    fillMetadata();

    fireEvent.click(screen.getByRole('radio', { name: /Update committee/ }));

    // The form is still standing, and the member is offered under the hex the
    // context handed over rather than under an encoding that cannot be made.
    await screen.findByText('Members to remove');
    expect(screen.getByDisplayValue(MALFORMED_MEMBER)).toBeTruthy();
    expect(screen.getByText(new RegExp(`${MALFORMED_MEMBER.slice(0, 8)}`))).toBeTruthy();
    // And it is not offered as a datalist suggestion, since it would not parse
    // back as a credential.
    expect(document.querySelector('#ga-committee-members option')).toBeNull();
  });

  // ------------------------------------------------------------------
  // Review modal. The model behind it is covered by previewModel.test.ts, so
  // these cover only what needs a DOM: the one round trip, the injection
  // boundary (server HTML in, everything else as text) and the modal's own
  // open/close behaviour. happy-dom's showModal() only flips `open`, so the
  // real focus trap and Tab order are not asserted here.
  // ------------------------------------------------------------------
  describe('review modal', () => {
    async function openReview() {
      const review = await screen.findByRole('button', { name: 'Review and submit' });
      fireEvent.click(review);
      return review as HTMLButtonElement;
    }

    it('names the action type above the title', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await fillCommitteePanel();
      await openReview();

      const title = await screen.findByRole('heading', { name: 'A committee change' }, SLOW);
      expect(title.previousElementSibling?.textContent).toBe('Update committee');
    });

    it('shows the server-rendered HTML under the abstract label', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await openReview();

      const abstractLabel = await screen.findByText('Abstract', { selector: 'p' }, SLOW);
      const body = abstractLabel.nextElementSibling as HTMLElement;
      expect(body.className).toContain('ga-abstract__body');
      expect(body.querySelector('strong')?.textContent).toBe('abstract');

      // One request for the three fields, nothing else.
      const previewCalls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls.filter(
        ([url]) => String(url).includes('/api/preview'),
      );
      expect(previewCalls).toHaveLength(1);
    });

    // The action page merges motivation and rationale before rendering, so a
    // link whose reference definition sits in the other field resolves there.
    // Sending the two fields apart would show that link as raw Markdown here
    // and as a link on the page.
    it('sends the abstract and one merged body, not the two body fields apart', async () => {
      const fetchMock = installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await openReview();
      await screen.findByText('Preview, nothing is published yet', {}, SLOW);

      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/preview'));
      const sent = JSON.parse(String(call?.[1]?.body)) as { parts: Record<string, string> };
      expect(Object.keys(sent.parts).sort()).toEqual(['abstract', 'body']);
      expect(sent.parts.body).toBe('The motivation\n\nThe rationale');
    });

    it('renders markup typed into the title as text, never as an element', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.change(screen.getByLabelText('Title'), {
        target: { value: '<script>alert(1)</script>' },
      });
      await openReview();

      const heading = await screen.findByRole('heading', { name: '<script>alert(1)</script>' }, SLOW);
      expect(heading.querySelector('script')).toBeNull();
      expect(document.querySelector('dialog script')).toBeNull();
    });

    it('does not link a reference whose scheme the allowlist refuses', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      fireEvent.change(screen.getByLabelText('Reference 1 label'), { target: { value: 'Looks helpful' } });
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), { target: { value: 'javascript:alert(1)' } });
      await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect([...dialog.querySelectorAll('a')].map(a => a.getAttribute('href'))).not.toContain('javascript:alert(1)');
      expect(screen.queryByText('Looks helpful')).toBeNull();
    });

    it('renders markup in the author name as text', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.change(screen.getByLabelText('Author name'), {
        target: { value: '<img src=x onerror=alert(1)>' },
      });
      await openReview();

      await screen.findByText(
        'Author: <img src=x onerror=alert(1)>, will be signed with your wallet key when you submit',
        {},
        SLOW,
      );
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect(dialog.querySelector('img')).toBeNull();
    });

    it('renders markup in a reference label as text on an otherwise allowed link', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      fireEvent.change(screen.getByLabelText('Reference 1 label'), {
        target: { value: '"><img src=x onerror=alert(1)>' },
      });
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), {
        target: { value: 'https://example.com/paper' },
      });
      await openReview();

      // The URI is allowed, so the link IS rendered, and only the label has to be
      // a text node rather than the markup it looks like.
      const link = await screen.findByRole('link', { name: '"><img src=x onerror=alert(1)>' }, SLOW);
      expect(link.getAttribute('href')).toBe('https://example.com/paper');
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect(dialog.querySelector('img')).toBeNull();
      expect(dialog.querySelector('[onerror]')).toBeNull();
    });

    it('drops a data: reference, which the scheme allowlist refuses', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('button', { name: 'Add reference' }));
      fireEvent.change(screen.getByLabelText('Reference 1 label'), { target: { value: 'A data url' } });
      fireEvent.change(screen.getByLabelText('Reference 1 URL'), {
        target: { value: 'data:text/html,x' },
      });
      await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect([...dialog.querySelectorAll('a')].map(a => a.getAttribute('href'))).not.toContain('data:text/html,x');
      expect(screen.queryByText('A data url')).toBeNull();
    });

    it('renders markup in a committee member name as text on the on-chain card', async () => {
      mocks.committeeContext = NAMED_COMMITTEE_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await fillCommitteePanel();
      await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      const dialog = document.querySelector('dialog') as HTMLElement;
      // The name reaches the card through the context, so it appears, and it
      // appears as the characters it is.
      expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(dialog.querySelector('img')).toBeNull();
      expect(dialog.querySelector('[onerror]')).toBeNull();
    });

    it('ignores a preview response that a newer one has already superseded', async () => {
      const first = deferred<Response>();
      const second = deferred<Response>();
      let call = 0;
      mocks.previewImpl = () => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      };

      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      const review = await openReview();
      await screen.findByText('Rendering the preview...', {}, SLOW);

      // Close, change the text, open again: request A is still in flight.
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await waitFor(() => expect(document.activeElement).toBe(review));
      fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: 'The new abstract' } });
      fireEvent.click(review);
      await screen.findByText('Rendering the preview...', {}, SLOW);

      // B answers first, then the stale A. The newer HTML has to survive.
      second.resolve(jsonResponse({ html: { abstract: '<p>NEW abstract</p>' } }));
      await screen.findByText('NEW abstract', {}, SLOW);
      first.resolve(jsonResponse({ html: { abstract: '<p>OLD abstract</p>' } }));

      await waitFor(() => expect(screen.queryByText('OLD abstract')).toBeNull());
      expect(screen.getByText('NEW abstract')).toBeTruthy();
    });

    it('renders no on-chain card for a committee payload that carries nothing', async () => {
      mocks.committeeContext = EMPTY_COMMITTEE_CONTEXT;
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      fireEvent.click(screen.getByRole('radio', { name: /Update committee/ }));
      await screen.findByText('There is no committee on record to remove members from.', {}, SLOW);
      await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      // Same gate the action page applies: no adds, no removes and no
      // threshold is no card at all, not an empty one.
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect(dialog.textContent).not.toContain('On-chain changes');
      // The missing list still explains itself: with no committee on record
      // there is no quorum to fall back to, so one has to be typed.
      expect(dialog.textContent).toContain('Quorum numerator');
    });

    it('lists what is still missing instead of refusing to preview', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Only a title' } });
      await openReview();

      const heading = await screen.findByText('Still missing', {}, SLOW);
      const items = [...(heading.parentElement as HTMLElement).querySelectorAll('li')].map(li => li.textContent);
      expect(items).toEqual(['Abstract', 'Motivation', 'Rationale']);
    });

    it('says the preview is unavailable and retries, leaving the form alone', async () => {
      mocks.previewImpl = async () => new Response('nope', { status: 500 });
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await openReview();

      await screen.findByText(/Preview unavailable, the form is unaffected/, {}, SLOW);
      mocks.previewImpl = null;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('A committee change');
    });

    it('locks the page behind it while open and unlocks it on Edit, with focus back on Review', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      const review = await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      expect(document.body.style.overflow).toBe('hidden');

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await waitFor(() => expect(screen.queryByText('Preview, nothing is published yet')).toBeNull());
      expect(document.body.style.overflow).not.toBe('hidden');
      expect(document.activeElement).toBe(review);
    });

    it('closes on Escape and returns focus to the Review button', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      const review = await openReview();

      await screen.findByText('Preview, nothing is published yet', {}, SLOW);
      fireEvent.keyDown(document.querySelector('dialog') as HTMLElement, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByText('Preview, nothing is published yet')).toBeNull());
      expect(document.activeElement).toBe(review);
    });
  });

  describe('success screen sync poll', () => {
    beforeEach(() => {
      mocks.capturedPolls = [];
      startStatusPollingMock.mockClear();
    });

    /**
     * Submits the InfoAction form, waits for the success callout, and
     * returns the captured poll plus the render result's own unmount, so a
     * test can drive the cleanup half of the wiring.
     */
    async function submitAndReachSuccess(): Promise<{ poll: CapturedStatusPoll; unmount: () => void }> {
      const pollsBefore = mocks.capturedPolls.length;
      const view = render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await connect();
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);
      await screen.findByText('Proposal submitted', {}, SLOW);
      // >= pollsBefore + 1 (never reset between two submissions in the same
      // test, unlike beforeEach) rather than a fixed 1, so a test that mounts
      // a second island after the first still waits for its own new entry.
      await waitFor(() => expect(mocks.capturedPolls.length).toBeGreaterThan(pollsBefore), SLOW);
      return { poll: mocks.capturedPolls[mocks.capturedPolls.length - 1], unmount: view.unmount };
    }

    it('says when the deposit comes back at the latest and warns about the stake key', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'f'.repeat(64) });
      await submitAndReachSuccess();

      expect(screen.getByText(/at the latest at the start of epoch 507/)).toBeTruthy();
      expect(screen.getByText(/the ledger sends the deposit to the treasury instead/)).toBeTruthy();
    });

    it('asks the status route for "<txHash>#0"', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'f'.repeat(64) });
      mocks.statusImpl = async () => jsonResponse({ synced: false, slug: null, draft: null });
      const fetchMock = installFetchMock();
      const { poll } = await submitAndReachSuccess();

      await poll.fetchStatus();
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/gov-action/status'));
      expect(String(call?.[0])).toContain(`id=${encodeURIComponent(`${'f'.repeat(64)}#0`)}`);
    });

    it('starts pending, then shows the thread link and the draft sentence once synced', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'f'.repeat(64) });
      const { poll } = await submitAndReachSuccess();

      act(() => poll.onUpdate({ kind: 'pending' }));
      // The interim state: the general explanation stays until the poll knows more.
      expect(screen.getByText(/appears in DRepTalk and on explorers only/)).toBeTruthy();
      expect(screen.queryByText('Your action is on DRepTalk')).toBeNull();

      act(() =>
        poll.onUpdate({
          kind: 'synced',
          slug: 'my-committee-change-ab12',
          draft: { slug: 'fund-tooling-c3d4', title: 'Fund tooling' },
        }),
      );

      expect(
        screen.getByRole('link', { name: 'Your action is on DRepTalk' }).getAttribute('href'),
      ).toBe('/t/my-committee-change-ab12/');
      const draftLink = screen.getByRole('link', { name: 'Fund tooling' });
      expect(draftLink.getAttribute('href')).toBe('/t/fund-tooling-c3d4/');
      expect(draftLink.parentElement?.textContent).toBe(
        'Linked to your Proposal Draft Fund tooling, the thread is now locked and the discussion continues on the action page.',
      );
    });

    it('shows the thread link with no draft sentence when no draft was linked', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'e'.repeat(64) });
      const { poll } = await submitAndReachSuccess();

      act(() => poll.onUpdate({ kind: 'synced', slug: 'my-info-action-cd34', draft: null }));

      expect(
        screen.getByRole('link', { name: 'Your action is on DRepTalk' }).getAttribute('href'),
      ).toBe('/t/my-info-action-cd34/');
      expect(screen.queryByText(/Linked to your Proposal Draft/)).toBeNull();
    });

    it('says the action is not synced yet once the ten minute window elapses', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'c'.repeat(64) });
      const { poll } = await submitAndReachSuccess();

      act(() => poll.onUpdate({ kind: 'timed-out' }));

      expect(screen.getByText(/Not synced yet/)).toBeTruthy();
      expect(
        screen.getByRole('link', { name: 'governance actions list' }).getAttribute('href'),
      ).toBe('/c/governance-actions/');
    });

    it('cancels the poll exactly once when the island unmounts', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'd'.repeat(64) });
      const { poll, unmount } = await submitAndReachSuccess();
      expect(poll.cancel).not.toHaveBeenCalled();

      unmount();

      expect(poll.cancel).toHaveBeenCalledTimes(1);
    });

    // DRepTalk is a multi-page Astro app, not a client-routed SPA, and the
    // success screen is terminal (its early return skips the form and the
    // "Use a different wallet" reset button, which only render pre-success):
    // there is no in-page control to submit a second proposal from the same
    // mounted island. A second submission is therefore always a fresh page
    // load, i.e. a fresh mount, which is exactly what this test drives: the
    // first mount's poll is torn down on unmount, and the second mount gets
    // its own independent poll for its own id, never reusing or extending
    // the first one.
    it('gives a fresh mount its own poll for its own id, independent of a prior submission', async () => {
      submitGovActionMock.mockResolvedValue({ txHash: 'a'.repeat(64) });
      const fetchMock = installFetchMock();
      const first = await submitAndReachSuccess();
      first.unmount();
      expect(first.poll.cancel).toHaveBeenCalledTimes(1);

      submitGovActionMock.mockResolvedValue({ txHash: 'b'.repeat(64) });
      const second = await submitAndReachSuccess();

      expect(mocks.capturedPolls.length).toBe(2);
      expect(second.poll).not.toBe(first.poll);
      expect(second.poll.cancel).not.toHaveBeenCalled();

      await second.poll.fetchStatus();
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/gov-action/status'));
      expect(String(call?.[0])).toContain(`id=${encodeURIComponent(`${'b'.repeat(64)}#0`)}`);
    });
  });

  // Reload-safe island: a return to visibility after a while hidden refetches
  // the current type's context, a stale-looking reading says its own age, and
  // a refetch that moves a default the panel resolves against says which one
  // changed. Fake timers throughout: the component is mounted only after
  // `vi.useFakeTimers()`, and every wait is a manual `advanceTimersByTimeAsync`
  // flush rather than testing-library's `waitFor`/`findBy*`, which hang under
  // happy-dom once real timers are replaced (see the polling mock above).
  describe('reload-safe context (visibility, age, change notes)', () => {
    function contextCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
      return fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/gov-action/context')).length;
    }

    /** Renders on NoConfidence (any chained type does) and flushes the initial context load. */
    async function mountOnNoConfidence() {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fireEvent.click(screen.getByRole('radio', { name: /No confidence/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    /** Hides the tab, advances by `hiddenMs`, then shows it again, flushing any refetch it triggers. */
    async function hideThenShow(hiddenMs: number) {
      const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(hiddenMs);
      });
      hiddenSpy.mockReturnValue(false);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      hiddenSpy.mockRestore();
    }

    it('refetches the context once the tab was hidden more than 60 s', async () => {
      const fetchMock = installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        expect(screen.getByText('The sitting committee')).toBeTruthy();
        const before = contextCallCount(fetchMock);

        await hideThenShow(61_000);

        expect(contextCallCount(fetchMock)).toBe(before + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not refetch when the tab was hidden 30 s or less', async () => {
      const fetchMock = installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        const before = contextCallCount(fetchMock);

        await hideThenShow(30_000);

        expect(contextCallCount(fetchMock)).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });

    // Finding 1 (Codex, review round 2): a visibility refetch racing the
    // submit's OWN freshness refetch could bump the request id the reducer
    // tracks, superseding the submit's request there, while `loadContext`
    // still handed its now-stale response back to `handleSubmit` regardless.
    // The fix gates the visibility refetch on `phase.status !== 'submitting'`
    // (checked through a ref, so the closure sees it live), which covers the
    // whole submit, not just the instant its own refetch is in flight. This
    // proves the gate itself, not just that a benign hide/show does nothing.
    it('never starts a background refetch while a submit is in flight, even after being hidden a long time', async () => {
      const fetchMock = installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        expect(screen.getByText('The sitting committee')).toBeTruthy();
        fillMetadata();

        fireEvent.click(screen.getByRole('button', { name: 'Connect wallet' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        const submit = signButton();
        expect(submit.disabled).toBe(false);

        const before = contextCallCount(fetchMock);
        const held = deferred<Response>();
        mocks.contextHold = held.promise;

        fireEvent.click(submit);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        // The submit's own freshness refetch has started (and is held open,
        // so it cannot resolve and move the submit past 'submitting' yet).
        expect(contextCallCount(fetchMock)).toBe(before + 1);

        await hideThenShow(61_000);

        // Still just the submit's own request: no background refetch snuck
        // in while phase was 'submitting', even though the tab was "hidden"
        // long enough that it otherwise would have started one.
        expect(contextCallCount(fetchMock)).toBe(before + 1);

        held.resolve(jsonResponse(mocks.committeeContext));
        mocks.contextHold = null;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows the chain context’s age once the reading is ten minutes old', async () => {
      installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        expect(screen.queryByText(/Chain context loaded/)).toBeNull();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(10 * 60_000);
        });

        expect(screen.getByText('Chain context loaded 10 minutes ago')).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('says which default changed after a refetch moves it, and drops the note on the next edit', async () => {
      installFetchMock();
      vi.useFakeTimers();
      try {
        await mountOnNoConfidence();
        expect(screen.getByText('The sitting committee')).toBeTruthy();

        mocks.committeeContext = {
          ...COMMITTEE_CONTEXT,
          committee: { ...COMMITTEE_CONTEXT.committee, quorum: { numerator: 3, denominator: 5 } },
        };
        await hideThenShow(61_000);

        expect(screen.getByText('The committee quorum changed to 3/5')).toBeTruthy();

        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'An edit' } });
        expect(screen.queryByText('The committee quorum changed to 3/5')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
