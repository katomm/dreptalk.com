// React island of the DRep group signing page. It shows what the transaction does in the words the
// server decoded from it, who must sign and who has, and offers the signing, submitting and
// cancelling steps. Signatures come from the connected wallet or from pasted cardano-signer output.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyButton } from '@/components/CopyButton.js';
import WalletConnection from '@/components/WalletConnection.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import type { WalletApi } from '@/lib/governance/walletUtxos.js';
import { rememberWallet, useCardanoWallets } from '@/lib/wallet/useCardanoWallets.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { readableError } from '@/lib/wallet/walletError.js';

type EnabledWalletApi = WalletApi & { getNetworkId(): Promise<number> };

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
  isInitiator?: boolean;
  feeInputs?: Array<{ txHash: string; index: number }>;
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

const shortKey = (k: string) => (k.length > 16 ? `${k.slice(0, 8)}...${k.slice(-6)}` : k);

const mono = { fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' } as const;

function Callout({ kind, children }: { kind: 'error' | 'info' | 'success'; children: React.ReactNode }) {
  return (
    <div className={`callout callout--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="callout__body">{children}</div>
    </div>
  );
}

function KeyList({ keys, signed }: { keys: string[]; signed: Set<string> }) {
  return (
    <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
      {keys.map((k) => (
        <li key={k} style={mono}>
          {shortKey(k)} {signed.has(k) ? '(signed)' : '(waiting)'}
        </li>
      ))}
    </ul>
  );
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ? `${fallback} ${body.error}.` : fallback;
}

export default function SigningPanel({ actionId, network }: SigningPanelProps) {
  const { wallets, selected, setSelected } = useCardanoWallets({ preferCip95: true });
  const apiRef = useRef<EnabledWalletApi | null>(null);
  const [view, setView] = useState<ActionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transient, setTransient] = useState<string | null>(null);
  const [cancelledForReal, setCancelledForReal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState('');
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

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

  const connect = useCallback(async (): Promise<EnabledWalletApi | null> => {
    if (apiRef.current) return apiRef.current;
    const info = wallets.find((w) => w.key === selected);
    if (!info) {
      setError('Select a wallet to continue.');
      return null;
    }
    try {
      const api = (await info.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;
      await assertWalletNetwork(api, network);
      apiRef.current = api;
      rememberWallet(selected);
      return api;
    } catch (err) {
      setError(readableError(err));
      return null;
    }
  }, [wallets, selected, network]);

  async function postWitness(witnessSetHex: string): Promise<boolean> {
    const res = await fetchWithTimeout(`/api/groups/actions/${actionId}/witness`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ witnessSetHex }),
    });
    if (!res.ok) throw new Error(await errorOf(res, 'Could not add the signature.'));
    const body = (await res.json()) as { accepted: string[] };
    if (body.accepted.length === 0) {
      setNote('None of the keys of this signature are signers of this action.');
      return false;
    }
    setNote(`Signature added for ${body.accepted.map(shortKey).join(', ')}.`);
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
      const assembled = await fetchWithTimeout(`/api/groups/actions/${actionId}/submit`, { method: 'POST' });
      if (!assembled.ok) throw new Error(await errorOf(assembled, 'Could not assemble the transaction.'));
      const { assembledTxHex } = (await assembled.json()) as { assembledTxHex: string };
      const api = await connect();
      if (!api) return;
      const txHash = await api.submitTx(assembledTxHex);
      const recorded = await fetchWithTimeout(`/api/groups/actions/${actionId}/submitted`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash }),
      }).catch(() => null);
      setSubmittedHash(txHash);
      if (!recorded?.ok) setNote(`Submitted (${txHash}). Recording it failed, it will be picked up shortly.`);
      await refresh();
    });

  const cancel = () =>
    run(async () => {
      const res = await fetchWithTimeout(`/api/groups/actions/${actionId}/cancel`, { method: 'POST' });
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
  const collecting = view.status === 'collecting';
  const confirming = view.status === 'submitted' && view.resolution === null;
  const command = `cardano-signer sign --data-hex ${view.bodyHash} --secret-key drep.skey`;
  const walletPicker =
    wallets.length === 0 ? (
      <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.875rem' }}>No Cardano wallet extension detected.</p>
    ) : (
      <WalletConnection wallets={wallets} selected={selected} onSelect={setSelected} disabled={busy} label="Signing wallet" />
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '40rem' }}>
      <section aria-label="What this transaction does">
        <h2 style={{ fontSize: '1.0625rem', margin: '0 0 0.5rem' }}>What this transaction does</h2>
        <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {view.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section aria-label="Signatures">
        <h2 style={{ fontSize: '1.0625rem', margin: '0 0 0.5rem' }}>Signatures</h2>
        <p style={{ margin: '0 0 0.25rem', fontWeight: 600, fontSize: '0.875rem' }}>Must sign</p>
        <KeyList keys={view.requiredSigners} signed={signedSet} />
        {view.optionalSigned.length > 0 && (
          <>
            <p style={{ margin: '0.75rem 0 0.25rem', fontWeight: 600, fontSize: '0.875rem' }}>May sign, already signed</p>
            <KeyList keys={view.optionalSigned} signed={signedSet} />
          </>
        )}
        <p role="status" aria-live="polite" style={{ margin: '0.75rem 0 0', fontSize: '0.875rem', color: view.satisfied ? 'var(--accent)' : 'var(--muted)', fontWeight: 600 }}>
          {view.satisfied ? 'All required signatures are collected.' : 'More signatures are needed.'}
        </p>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
          Expires {new Date(view.expiresAt * 1000).toLocaleString()}
        </p>
      </section>

      {view.resolution && <Callout kind={view.resolution === 'applied' ? 'success' : 'info'}>{RESOLUTION_TEXT[view.resolution]}</Callout>}
      {confirming && (
        <Callout kind="info">
          The transaction is submitted and waiting for the chain to confirm it. This can take a few minutes.
          {submittedHash && (
            <>
              {' '}
              <a href={txExplorerUrl(network, submittedHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                View transaction
              </a>
            </>
          )}
        </Callout>
      )}
      {view.status === 'cancelled' && <Callout kind="info">This signing link was cancelled. {view.isInitiator ? CANCEL_NOTE : ''}</Callout>}

      {collecting && (
        <section aria-label="Add your signature" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h2 style={{ fontSize: '1.0625rem', margin: 0 }}>Add your signature</h2>
          {walletPicker}
          {wallets.length > 0 && (
            <button type="button" className="btn btn-primary" onClick={() => void signWithWallet()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
              Sign with wallet
            </button>
          )}
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
            Or sign the transaction body hash offline with your DRep key and paste the output.
          </p>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
            <pre style={{ ...mono, flex: 1, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{command}</pre>
            <CopyButton value={command} label="Copy command" />
          </div>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            aria-label="cardano-signer output"
            placeholder='Paste the cardano-signer JSON output here, e.g. { "signature": "...", "publicKey": "..." }'
            rows={4}
            disabled={busy}
            style={{ ...mono, width: '100%', padding: '0.625rem 0.75rem', border: '1px solid var(--border)', borderRadius: '0.375rem', background: 'var(--bg)', color: 'var(--fg)', boxSizing: 'border-box' }}
          />
          <button type="button" className="btn" onClick={() => void addPasted()} disabled={busy || !paste.trim()} style={{ alignSelf: 'flex-start' }}>
            Add signature
          </button>
        </section>
      )}

      {collecting && view.canSubmit && (
        <section aria-label="Submit" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>Every required signature is collected. Submitting sends the transaction to the chain.</p>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Submit transaction
          </button>
        </section>
      )}

      {view.isInitiator && collecting && (
        <section aria-label="Cancel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>{CANCEL_NOTE}</p>
          <button type="button" className="btn" onClick={() => void cancel()} disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Cancel this signing link
          </button>
        </section>
      )}

      {view.isInitiator && view.status === 'cancelled' && (view.feeInputs?.length ?? 0) > 0 && !cancelledForReal && (
        <section aria-label="Cancel for real" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
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
