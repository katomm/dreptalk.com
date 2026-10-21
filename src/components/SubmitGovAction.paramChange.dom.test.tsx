// @vitest-environment happy-dom
// More DOM tests for the submit island, split off SubmitGovAction.dom.test.tsx
// so vitest runs them in parallel. Why these tests exist is explained there.
// The environment is file-scoped on purpose: the node and workers test
// projects keep their own environments.
//
// The shared mocks and helpers live in __fixtures__/submitGovActionHarness.ts.
// This file: parameter changes.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import SubmitGovAction from './SubmitGovAction.js';
import { loadGovActionDraft } from '@/lib/governance/govActionDraft.js';
import { GUARDRAIL_SCRIPT_HASH_HEX } from '@/lib/governance/guardrailScript.js';
import { PARAM_EVALUATION_FAILED_MESSAGE } from '@/lib/governance/govActionErrors.js';
import { PREV_ACTION_CHANGED } from '@/lib/governance/govActionFormState.js';
import { changesParagraph, valuesFromJson } from '@/lib/governance/paramDefs.js';
import { INFO_ABSTRACT_MAX } from '@/lib/governance/infoActionLimits.js';
import {
  useSubmitGovActionHarness,
  SLOW,
  submitGovActionMock,
  DRAFT_KEY,
  DISPLAY_NAME,
  PARAM_CONTEXT,
  paramContextWithRoot,
  installFetchMock,
  installWalletMock,
  connect,
  signButton,
  fillMetadata,
  fillParamPanel,
  requestsTo,
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

  describe('parameter changes', () => {
    beforeEach(() => {
      mocks.committeeContext = PARAM_CONTEXT;
    });

    it('notes the 90 day guardrail and the linked draft age next to the draft link', async () => {
      installFetchMock();
      const now = Date.now();
      const drafts = [
        { slug: 'young-draft-a1b2', title: 'Young draft', createdAt: now - 12 * 86_400_000 - 60_000, own: true },
        { slug: 'old-draft-c3d4', title: 'Old draft', createdAt: now - 120 * 86_400_000, own: false },
      ];
      render(
        <SubmitGovAction network="preprod" displayName={DISPLAY_NAME} openDrafts={drafts} siteOrigin="https://preprod.dreptalk.com" />,
      );
      await fillParamPanel({});
      expect(screen.queryByText(/days normally pass/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'utxoCostPerByte' }));
      const select = screen.getByLabelText('Link a Proposal Draft');
      const note = () => select.parentElement?.textContent ?? '';
      expect(note()).toContain('No Proposal Draft is linked yet.');
      fireEvent.change(select, { target: { value: 'young-draft-a1b2' } });
      expect(note()).toContain('Your linked draft was published 12 days ago.');
      fireEvent.change(select, { target: { value: 'old-draft-c3d4' } });
      expect(note()).toContain('Your linked draft was published 120 days ago, at least the 90 days');
    });

    it('offers the parameter change card on preprod and loads the pool data once', async () => {
      const fetchMock = installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await fillParamPanel({});
      await waitFor(() => expect(requestsTo(fetchMock, '/api/gov-action/pool-economics')).toBe(1), SLOW);
      expect(requestsTo(fetchMock, '/api/gov-action/context?type=ParameterChange')).toBe(1);

      fireEvent.click(screen.getByRole('radio', { name: /Info action/ }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'k' })).toBeNull());
      fireEvent.click(screen.getByRole('radio', { name: /Protocol parameter change/ }));
      await screen.findByRole('button', { name: 'k' }, SLOW);
      expect(requestsTo(fetchMock, '/api/gov-action/pool-economics')).toBe(1);
    });

    it('retries the pool data after a failure', async () => {
      mocks.poolEconomicsFailures = 1;
      const fetchMock = installFetchMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await fillParamPanel({ k: '600' });
      expect((await screen.findAllByText('Impact figures are unavailable right now.', {}, SLOW)).length).toBeGreaterThan(0);

      fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
      await waitFor(() => expect(screen.queryByText('Impact figures are unavailable right now.')).toBeNull(), SLOW);
      expect(requestsTo(fetchMock, '/api/gov-action/pool-economics')).toBe(2);
      const card = screen.getByRole('group', { name: 'Target number of pools' });
      expect(within(card).getAllByText(/64\.9M ₳/).length).toBeGreaterThan(0);
    });

    it('builds a ParameterChange spec with the chosen previous action and the exact values', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillParamPanel({ k: '600', a0: '0.35' });

      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      const opts = submitGovActionMock.mock.calls[0][0] as { action: unknown };
      expect(opts.action).toEqual({
        type: 'ParameterChange',
        prev: null,
        values: { k: { n: 600n, d: 1n }, a0: { n: 7n, d: 20n } },
        guardrail: { state: 'known', scriptHash: GUARDRAIL_SCRIPT_HASH_HEX },
      });
    });

    it('shows the changed parameters in the review', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      fillMetadata();
      await fillParamPanel({ k: '600', a0: '0.35' });
      fireEvent.click(await screen.findByRole('button', { name: 'Review and submit' }));

      const dialog = await screen.findByRole('dialog', {}, SLOW);
      const rowOf = (label: string) => within(dialog).getByText(label).closest('li') as HTMLElement;
      await within(dialog).findByText('On-chain changes', {}, SLOW);
      const k = rowOf('Target number of pools (k)');
      expect(within(k).getByText('500')).toBeTruthy();
      expect(within(k).getByText('600')).toBeTruthy();
      const a0 = rowOf('Pledge influence (a0)');
      expect(within(a0).getByText('Technical')).toBeTruthy();
      expect(within(a0).getByText('0.3')).toBeTruthy();
      expect(within(a0).getByText('0.35')).toBeTruthy();
    });

    /** Fills the form on the given chain, then answers the submit's refetch with a root that moved. */
    async function rootMoves(loaded: unknown) {
      mocks.committeeContext = loaded;
      const fetchMock = installFetchMock();
      const api = installWalletMock();
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillParamPanel({ k: '600' });
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);

      mocks.committeeContext = paramContextWithRoot('9'.repeat(64));
      fireEvent.click(submit);

      expect((await screen.findAllByText(PREV_ACTION_CHANGED, { exact: false }, SLOW)).length).toBeGreaterThan(0);
      expect(api.signData).not.toHaveBeenCalled();
      expect(requestsTo(fetchMock, '/api/gov-action/metadata')).toBe(0);
      expect(submitGovActionMock).not.toHaveBeenCalled();
    }

    it('stops before signing when the chain root moved from none to a change', async () => {
      await rootMoves(PARAM_CONTEXT);
    });

    it('stops before signing when the chain root moved from one change to another', async () => {
      await rootMoves(paramContextWithRoot('d'.repeat(64)));
    });

    it('words a guardrail rejection for a parameter change', async () => {
      const inner = Object.assign(new Error('Script evaluation failed'), {
        cause: { code: 'evaluation_failed', detail: 'Validator returned False' },
      });
      submitGovActionMock.mockRejectedValue(
        Object.assign(new Error('Script evaluation failed: evaluation_failed'), { cause: inner }),
      );
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillParamPanel({ k: '600' });
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      expect(await screen.findByText(PARAM_EVALUATION_FAILED_MESSAGE, { exact: false }, SLOW)).toBeTruthy();
    });

    it('names a stale previous action even when the form built on a null root', async () => {
      submitGovActionMock.mockRejectedValue(new Error('ConwayGovFailure (InvalidPrevGovActionId ...)'));
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await connect();
      fillMetadata();
      await fillParamPanel({ k: '600' });
      const submit = signButton();
      await waitFor(() => expect(submit.disabled).toBe(false), SLOW);
      fireEvent.click(submit);

      await waitFor(() => expect(submitGovActionMock).toHaveBeenCalledTimes(1), SLOW);
      expect((submitGovActionMock.mock.calls[0][0] as { action: { prev: unknown } }).action.prev).toBeNull();
      expect((await screen.findAllByText(PREV_ACTION_CHANGED, { exact: false }, SLOW)).length).toBeGreaterThan(0);
    });

    it('adds the changes paragraph to the abstract only on request', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await fillParamPanel({ k: '600' });
      const abstract = screen.getByLabelText('Abstract') as HTMLTextAreaElement;
      expect(abstract.value).toBe('');

      const paragraph = changesParagraph({ k: { n: 600n, d: 1n } }, valuesFromJson(PARAM_CONTEXT.params));
      expect(paragraph).toContain('500 to 600. The constitution allows 250 to 2,000.');
      // The box previews exactly the lines a click adds.
      const box = await screen.findByRole('region', { name: 'Changes paragraph' }, SLOW);
      expect(box.textContent).toContain('Target number of pools (k): 500 to 600. The constitution allows 250 to 2,000.');
      expect(box.textContent).toContain('Optional.');
      const add = within(box).getByRole('button', { name: 'Add to abstract' });
      fireEvent.click(add);
      await waitFor(() => expect((screen.getByLabelText('Abstract') as HTMLTextAreaElement).value).toBe(paragraph));

      // The same values a second time: already there, so the button says so and does nothing.
      const added = within(box).getByRole('button', { name: 'Added' }) as HTMLButtonElement;
      expect(added.disabled).toBe(true);
      expect(screen.queryByRole('button', { name: 'Add to abstract' })).toBeNull();

      const edited = `${paragraph}\n\nWhy now: the pool count has grown.`;
      fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: edited } });
      await waitFor(() => expect(loadGovActionDraft(window.localStorage, DRAFT_KEY)?.abstract).toBe(edited), SLOW);
    });

    it('replaces an earlier changes block after a value change instead of adding a second one', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await fillParamPanel({ k: '600' });
      const current = valuesFromJson(PARAM_CONTEXT.params);
      const first = changesParagraph({ k: { n: 600n, d: 1n } }, current);
      fireEvent.click(await screen.findByRole('button', { name: 'Add to abstract' }, SLOW));
      await waitFor(() => expect((screen.getByLabelText('Abstract') as HTMLTextAreaElement).value).toBe(first));
      const around = `Intro line.\n\n${first}\n\nWhy now: the pool count has grown.`;
      fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: around } });

      fireEvent.change(screen.getByRole('textbox', { name: 'New Target number of pools' }), { target: { value: '700' } });
      const second = changesParagraph({ k: { n: 700n, d: 1n } }, current);
      // An earlier block with old values: the button says the click updates it.
      fireEvent.click(await screen.findByRole('button', { name: 'Update in abstract' }, SLOW));

      const expected = `Intro line.\n\n${second}\n\nWhy now: the pool count has grown.`;
      await waitFor(() => expect((screen.getByLabelText('Abstract') as HTMLTextAreaElement).value).toBe(expected));
      const value = (screen.getByLabelText('Abstract') as HTMLTextAreaElement).value;
      expect(value.split('Changes:').length).toBe(2);
      expect(value).toContain('500 to 700.');
      expect(value).not.toContain('500 to 600.');
      expect((screen.getByRole('button', { name: 'Added' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('disables adding the changes when the abstract has no room for them', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await fillParamPanel({ k: '600' });
      fireEvent.change(screen.getByLabelText('Abstract'), { target: { value: 'x'.repeat(INFO_ABSTRACT_MAX - 10) } });

      const add = (await screen.findByRole('button', { name: 'Add to abstract' }, SLOW)) as HTMLButtonElement;
      await waitFor(() => expect(add.disabled).toBe(true));
      expect(screen.getByText('The abstract has no room for the changes paragraph.')).toBeTruthy();
    });

    it('Continue focuses the title field', async () => {
      render(<SubmitGovAction network="preprod" displayName={DISPLAY_NAME} />);
      await fillParamPanel({ k: '600' });
      const next = screen.getByRole('button', { name: 'Continue to rationale' }) as HTMLButtonElement;
      await waitFor(() => expect(next.disabled).toBe(false), SLOW);
      fireEvent.click(next);
      expect(document.activeElement).toBe(document.getElementById('ia-title'));
    });
  });
});
