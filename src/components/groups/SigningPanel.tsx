// React island of the DRep group signing page. It shows what the transaction does in the words the
// server decoded from it, who must sign and who has, and offers the signing, submitting and
// cancelling steps. Signatures come from the connected wallet or from pasted cardano-signer output.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CopyButton } from '@/components/CopyButton.js';
import WalletConnection from '@/components/WalletConnection.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { keyLabel } from '@/lib/groups/describe.js';
import { INPUT_SPENT_TEXT } from '@/lib/groups/view.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { inputStyle, labelStyle } from '@/components/drepFormStyles.js';
import { Callout, card, errorOf, fieldHeading, h2, muted, post, rows, stack, useWalletConnect } from './groupUi.js';

/** Shape returned by GET /api/groups/actions/[id]. */
export interface ActionView {
  id: string;
  kind: string;
  status: 'collecting' | 'submitted' | 'cancelled';
  resolution: 'applied' | 'partial' | 'failed' | 'never_included' | null;
  groupId: string;
  lines: string[];
  requiredSigners: string[];
  signed: string[];
  optionalSigned: string[];
  satisfied: boolean;
  expiresAt: number;
  unsignedTxCbor: string;
  bodyHash: string;
  canSubmit: boolean;
  /** A fee input was spent by another transaction, this one can never be submitted. */
  feeInputSpent?: boolean;
  isInitiator?: boolean;
  feeInputs?: Array<{ txHash: string; index: number }>;
  /** The viewer's DRep key hash, null for a session without one. */
  viewerKey?: string | null;
  /** DRep names of the signers and the viewer, by key hash. */
  names?: Record<string, string>;
  /** Whether the initiator's wallet signed for the fee inputs. */
  fundingSigned?: boolean;
}

export interface SigningPanelProps {
  actionId: string;
  network: CardanoNetwork;
}

const POLL_MS = 4000;

const RESOLUTION_TEXT: Record<NonNullable<ActionView['resolution']>, string> = {
  applied: 'The transaction is confirmed and the group change is in effect.',
  partial: 'The transaction is confirmed, but only some of its changes took effect.',
  failed: 'The transaction is confirmed, but the group rules did not accept its changes.',
  never_included: 'The transaction never reached the chain and its time ran out. Start again if you still want this change.',
};

const CANCEL_NOTE =
  'Cancelling stops this link for everyone. Signatures that were already handed out stay usable until the expiry below, so a copy of this transaction could still be submitted by someone who holds it. To make it unusable for good, use "Cancel for real", which spends the fee input back to your wallet.';

const mono = { fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' } as const;

function KeyList({ keys, signed, nameOf }: { keys: string[]; signed: Set<string>; nameOf: (k: string) => string }) {
  return (
    <ul style={rows}>
      {keys.map((k) => (
        <li key={k} data-key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'baseline' }}>
          <span style={{ overflowWrap: 'anywhere' }}>{nameOf(k)}</span>
          <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: signed.has(k) ? 'var(--accent)' : 'var(--muted)', whiteSpace: 'nowrap' }}>
            {signed.has(k) ? 'Signed' : 'Waiting'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Where the signatures stand after the viewer signed: who is still missing, or what comes next. */
function progressText(view: ActionView, missing: string[], nameOf: (k: string) => string): string {
  if (view.status === 'submitted') return 'The transaction is being submitted and waits for the chain to confirm it.';
  const fee = view.fundingSigned === false ? ' The initiator still has to sign for the fee with the wallet that pays it.' : '';
  if (missing.length === 0) return view.canSubmit ? 'Every required signature is collected. The transaction can be submitted now.' : `Every required DRep signature is collected.${fee}`;
  const count = missing.length === 1 ? '1 signature is still missing' : `${missing.length} signatures are still missing`;
  return `${count}: ${missing.map(nameOf).join(', ')}.${fee}`;
}

export default function SigningPanel({ actionId, network }: SigningPanelProps) {
  const [view, setView] = useState<ActionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transient, setTransient] = useState<string | null>(null);
  const [cancelledForReal, setCancelledForReal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState('');
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);
  // Set once a signature of this visit was stored, the success notice then says so.
  const [justSigned, setJustSigned] = useState(false);
  const { wallets, walletKey: selected, setWalletKey: setSelected, connect } = useWalletConnect(network, setError);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  // A signer by DRep name, else by the short DRep id of the key.
  const names = useMemo(() => new Map(Object.entries(view?.names ?? {}).map(([k, v]) => [k.toLowerCase(), v])), [view?.names]);
  const nameOf = useCallback((k: string) => keyLabel(k, names), [names]);
  const refresh = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`/api/groups/actions/${actionId}`);
      if (res.ok) {
        setView((await res.json()) as ActionView);
        setLoadError(null);
        setTransient(null);
      } else if (res.status === 401) {
        window.location.assign('/login/');
      } else if (res.status === 403 || res.status === 404) {
        setLoadError('This signing link is not available to your login.');
      } else if (res.status === 410) {
        setLoadError('This signing link has expired.');
      } else if (res.status === 409 || res.status === 503) {
        // Not terminal, the chain or the store may just be busy. Polling goes on.
        setTransient(await errorOf(res, 'This action cannot be shown right now, trying again.'));
      }
    } catch {
      // A transient read error is not fatal, the next poll retries.
    }
  }, [actionId]);

  const finished = view ? view.status === 'cancelled' || view.resolution !== null : false;
  useEffect(() => {
    if (loadError || finished) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, loadError, finished]);

  async function postWitness(witnessSetHex: string): Promise<boolean> {
    const res = await post(`/api/groups/actions/${actionId}/witness`, { witnessSetHex });
    if (!res.ok) throw new Error(await errorOf(res, 'Could not add the signature.'));
    const body = (await res.json()) as { accepted: string[] };
    if (body.accepted.length === 0) throw new Error('None of the keys of this signature is a signer of this action.');
    setJustSigned(true);
    return true;
  }

  async function run(step: () => Promise<void>) {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      await step();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  const signWithWallet = () =>
    run(async () => {
      if (!view) return;
      const api = await connect();
      if (!api) return;
      const witnessSetHex = await api.signTx(view.unsignedTxCbor, true);
      await postWitness(witnessSetHex);
      await refresh();
    });

  const addPasted = () =>
    run(async () => {
      let signature: string;
      let publicKey: string;
      try {
        const obj = JSON.parse(paste.trim()) as { signature?: unknown; publicKey?: unknown };
        if (typeof obj.signature !== 'string' || typeof obj.publicKey !== 'string') throw new Error('missing fields');
        signature = obj.signature.trim();
        publicKey = obj.publicKey.trim();
      } catch {
        throw new Error('Paste the full JSON output from cardano-signer, it must contain "signature" and "publicKey".');
      }
      const { TransactionWitnessSet, VKey, Ed25519Signature } = await import('@evolution-sdk/evolution');
      const { hexToBytes } = await import('@/lib/crypto/hex.js');
      const witnessSetHex = TransactionWitnessSet.toCBORHex(
        TransactionWitnessSet.fromVKeyWitnesses([
          new TransactionWitnessSet.VKeyWitness({
            vkey: VKey.fromBytes(hexToBytes(publicKey)),
            signature: Ed25519Signature.fromBytes(hexToBytes(signature)),
          }),
        ]),
      );
      if (await postWitness(witnessSetHex)) setPaste('');
      await refresh();
    });

  const submit = () =>
    run(async () => {
      const assembled = await post(`/api/groups/actions/${actionId}/submit`);
      if (!assembled.ok) throw new Error(await errorOf(assembled, 'Could not assemble the transaction.'));
      const { assembledTxHex } = (await assembled.json()) as { assembledTxHex: string };
      const api = await connect();
      if (!api) return;
      const txHash = await api.submitTx(assembledTxHex);
      // The transaction is on its way, a failed record is only reported in the note below.
      const recorded = await post(`/api/groups/actions/${actionId}/submitted`, { txHash }).catch(() => null);
      setSubmittedHash(txHash);
      if (!recorded?.ok) setNote(`Submitted (${txHash}). Recording it failed, it will be picked up shortly.`);
      await refresh();
    });

  const cancel = () =>
    run(async () => {
      const res = await post(`/api/groups/actions/${actionId}/cancel`);
      if (!res.ok) throw new Error(await errorOf(res, 'Could not cancel.'));
      await refresh();
    });

  const cancelForReal = () =>
    run(async () => {
      if (!view?.feeInputs?.length) throw new Error('There is no fee input left to spend.');
      const api = await connect();
      if (!api) return;
      const { buildSendToSelf } = await import('@/lib/groups/groupTx.js');
      const { txHash } = await buildSendToSelf({ walletApi: api, network, origin, inputs: view.feeInputs });
      setCancelledForReal(true);
      setNote(`The fee input was sent back to your wallet in transaction ${txHash}. This action can no longer be submitted.`);
    });

  if (loadError) return <Callout kind="error">{loadError}</Callout>;
  if (!view) {
    return transient ? <Callout kind="info">{transient}</Callout> : <p style={{ color: 'var(--muted)', margin: 0 }}>Loading the action...</p>;
  }

  const signedSet = new Set([...view.signed, ...view.optionalSigned]);
  const open = view.status === 'collecting' && view.resolution === null;
  // A collecting row whose fee input another transaction spent can never be valid. The resolver
  // later marks it never included, until then it stays open for its initiator to cancel.
  const dead = view.feeInputSpent === true && view.status === 'collecting' && (view.resolution === null || view.resolution === 'never_included');
  // A resolved row (never included, its time ran out) and a dead one take no more signatures.
  const collecting = open && !dead;
  const confirming = view.status === 'submitted' && view.resolution === null;
  const command = `cardano-signer sign --data-hex ${view.bodyHash} --secret-key drep.skey`;
  const viewerKey = view.viewerKey ?? null;
  const viewerSigned = viewerKey !== null && signedSet.has(viewerKey);
  // The wallet signs only for the required signers the transaction was built with, and the
  // initiator's wallet for the fee inputs.
  const viewerRequired = viewerKey !== null && view.requiredSigners.includes(viewerKey);
  const feeWanted = view.isInitiator === true && view.fundingSigned === false;
  const maySign = collecting && ((viewerRequired && !viewerSigned) || feeWanted);
  const missing = view.requiredSigners.filter((k) => !signedSet.has(k));
  const walletPicker =
    wallets.length === 0 ? (
      <p style={muted}>No Cardano wallet extension detected.</p>
    ) : (
      <WalletConnection wallets={wallets} selected={selected} onSelect={setSelected} disabled={busy} label="Signing wallet" />
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '40rem' }}>
      <section aria-label="What this transaction does" style={card}>
        <h2 style={{ ...h2, margin: 0 }}>What this transaction does</h2>
        <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {view.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section aria-label="Signatures" style={card}>
        <h2 style={{ ...h2, margin: 0 }}>Signatures</h2>
        <p style={fieldHeading}>Must sign</p>
        <KeyList keys={view.requiredSigners} signed={signedSet} nameOf={nameOf} />
        {view.optionalSigned.length > 0 && (
          <>
            <p style={fieldHeading}>May sign, already signed</p>
            <KeyList keys={view.optionalSigned} signed={signedSet} nameOf={nameOf} />
          </>
        )}
        <p role="status" aria-live="polite" style={{ margin: 0, fontSize: '0.875rem', fontWeight: 600, color: view.satisfied ? 'var(--accent)' : 'var(--muted)' }}>
          {view.satisfied ? 'All required signatures are collected.' : 'More signatures are needed.'}
        </p>
        <p style={{ ...muted, fontSize: '0.8125rem' }}>Expires {new Date(view.expiresAt * 1000).toLocaleString()}</p>
      </section>

      {dead && (
        <Callout kind="error">
          {INPUT_SPENT_TEXT} {open && view.isInitiator ? 'Cancel it and start it again.' : 'Start it again if you still want this change.'}
        </Callout>
      )}
      {viewerSigned && !dead && view.resolution === null && view.status !== 'cancelled' && (
        <Callout kind="success" title={justSigned ? 'Signature added' : 'You have signed'}>
          {nameOf(viewerKey as string)} signed this transaction. {progressText(view, missing, nameOf)}
        </Callout>
      )}
      {view.resolution && !dead && <Callout kind={view.resolution === 'applied' ? 'success' : 'info'}>{RESOLUTION_TEXT[view.resolution]}</Callout>}
      {confirming && (
        <Callout kind="info">
          The transaction is submitted and waiting for the chain to confirm it. This can take a few minutes.
          {submittedHash && (
            <>
              {' '}
              <a href={txExplorerUrl(network, submittedHash)} target="_blank" rel="noopener noreferrer">
                View transaction
              </a>
            </>
          )}
        </Callout>
      )}
      {view.status === 'cancelled' && (
        <Callout kind="info">This signing link was cancelled. {view.isInitiator && !view.feeInputSpent ? CANCEL_NOTE : ''}</Callout>
      )}

      {collecting && !maySign && !viewerSigned && (
        <Callout kind="info">
          Your DRep key is not a signer of this transaction. Its signers were chosen when it was built: {view.requiredSigners.map(nameOf).join(', ')}.
        </Callout>
      )}

      {maySign && (
        <section aria-label="Add your signature" style={card}>
          <h2 style={{ ...h2, margin: 0 }}>{viewerRequired && !viewerSigned ? 'Add your signature' : 'Sign for the fee'}</h2>
          {!(viewerRequired && !viewerSigned) && <p style={muted}>Your DRep signature is in. The wallet that pays the fee still has to sign.</p>}
          {walletPicker}
          {wallets.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={() => void signWithWallet()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
              Sign with wallet
            </button>
          )}
          {viewerRequired && !viewerSigned && (
            <>
              <p style={{ ...muted, fontSize: '0.8125rem', marginTop: '0.5rem' }}>Or sign the transaction body hash offline with your DRep key and paste the output.</p>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <pre style={{ ...mono, flex: 1, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{command}</pre>
                <CopyButton value={command} label="Copy command" />
              </div>
              <label style={labelStyle} htmlFor="gs-paste">
                cardano-signer output
              </label>
              <textarea
                id="gs-paste"
                style={{ ...inputStyle, ...mono, fontSize: '0.875rem', resize: 'vertical' }}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder='{ "signature": "...", "publicKey": "..." }'
                rows={4}
                disabled={busy}
              />
              <button type="button" className="btn" onClick={() => void addPasted()} disabled={busy || !paste.trim()} style={{ alignSelf: 'flex-start' }}>
                Add signature
              </button>
            </>
          )}
        </section>
      )}

      {collecting && view.canSubmit && (
        <section aria-label="Submit" style={stack}>
          <p style={muted}>Every required signature is collected. Submitting sends the transaction to the chain.</p>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Submit transaction
          </button>
        </section>
      )}

      {view.isInitiator && open && (
        <section aria-label="Cancel" style={stack}>
          {!dead && <p style={muted}>{CANCEL_NOTE}</p>}
          <button type="button" className="btn" onClick={() => void cancel()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Cancel this signing link
          </button>
        </section>
      )}

      {view.isInitiator && view.status === 'cancelled' && !view.feeInputSpent && (view.feeInputs?.length ?? 0) > 0 && !cancelledForReal && (
        <section aria-label="Cancel for real" style={stack}>
          {walletPicker}
          <button type="button" className="btn" onClick={() => void cancelForReal()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Cancel for real
          </button>
        </section>
      )}

      {transient && <Callout kind="info">{transient}</Callout>}
      {note && <p role="status" style={{ margin: 0, fontSize: '0.875rem' }}>{note}</p>}
      {error && <Callout kind="error">{error}</Callout>}
    </div>
  );
}
