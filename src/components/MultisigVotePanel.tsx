// React island: member-facing UI for a native-script (multisig) DRep vote.
//
// Two modes share this component:
//
// INITIATE (mounted on a gov-action thread for a script-DRep member): pick a
// vote + optional rationale, connect a wallet to fund and build the unsigned tx
// client-side, store it via POST /api/drep/multisig, then show a shareable
// cosign link and live signature progress.
//
// WITNESS (the /drep/cosign/<id> page): load the pending vote, let a member add
// their witness by pasting cardano-signer output (a CIP-30 wallet cannot produce
// a script member's DRep-key witness, so the member signs the tx body hash
// offline with their ed25519 DRep key), and once the script is satisfied submit
// the assembled tx with the funding wallet.
//
// Protocol note: member witnesses come ONLY from cardano-signer. The wallet is
// used only to fund the build (initiate) and to add the funding-input witness +
// submit (witness). The funder's wallet is the only one that can sign the inputs,
// so submission must happen from the wallet that built the tx.
import { useState, useRef, useEffect, useCallback } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import { CopyButton as CopyIdButton } from '@/components/CopyButton.js';
import { useCardanoWallets, rememberWallet } from '@/lib/wallet/useCardanoWallets.js';
import type { WalletApi as TxWalletApi } from '@/lib/governance/drepTx.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { txExplorerUrl } from '@/lib/config/network.js';
import { readableError } from '@/lib/wallet/walletError.js';
import { assertWalletNetwork } from '@/lib/wallet/networkGuard.js';
import { parseDrepId } from '@/lib/cardano/identity.js';
import WalletConnection from '@/components/WalletConnection.js';
import RationaleModal from '@/components/RationaleModal.js';
import { srOnlyRadio } from '@/components/srOnlyRadio.js';

// The enabled wallet api surface: CIP-30 tx methods + getNetworkId for the
// network guard. The CIP-95 extension is requested for parity with the key-vote
// flow, but here only the funding utxos and signTx/submitTx are used.
type EnabledWalletApi = TxWalletApi & {
  getNetworkId(): Promise<number>;
};

type VoteChoice = 'yes' | 'no' | 'abstain';

// Shape returned by GET /api/drep/multisig/[id].
interface PendingState {
  id: string;
  drepId: string;
  gaId: string;
  vote: string;
  anchorUrl: string | null;
  status: string;
  txHash: string | null;
  satisfied: boolean;
  signedLeaves: number;
  totalLeaves: number;
  threshold: number | null;
  signers: string[];
  unsignedTxCbor: string;
  bodyHash: string;
  expiresAt: number;
}

export interface MultisigVotePanelProps {
  gaId: string;
  network: CardanoNetwork;
  scriptDrepId: string;
  mode: 'initiate' | 'witness';
  /** Required in witness mode: the pending multisig id from the cosign URL. */
  pendingId?: string;
}

const monoBlockStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.8125rem',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '0.375rem',
  padding: '0.625rem 0.75rem',
  wordBreak: 'break-all',
  whiteSpace: 'pre-wrap',
  margin: 0,
};

// Small copy button shared by the share link and the cardano-signer command.
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      style={{
        background: 'none',
        border: '1px solid var(--border)',
        borderRadius: '0.25rem',
        color: 'var(--accent)',
        cursor: 'pointer',
        fontSize: '0.75rem',
        padding: '0.15rem 0.5rem',
        fontFamily: 'inherit',
        lineHeight: 1.4,
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

// Inline error callout, reusing the site callout classes from VotePanel.
function ErrorCallout({ message }: { message: string }) {
  return (
    <div className="callout callout--error" role="alert">
      <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div className="callout__body">{message}</div>
    </div>
  );
}

// Progress line: "satisfied" or "{signed} of {threshold ?? total} signatures".
function ProgressLine({ pending }: { pending: PendingState }) {
  const need = pending.threshold ?? pending.totalLeaves;
  return (
    <p role="status" aria-live="polite" style={{ margin: 0, fontSize: '0.875rem', color: pending.satisfied ? 'var(--accent)' : 'var(--muted)', fontWeight: 600 }}>
      {pending.satisfied
        ? 'All required signatures collected.'
        : `${pending.signedLeaves} of ${need} signatures collected.`}
    </p>
  );
}

export default function MultisigVotePanel({ gaId, network, scriptDrepId, mode, pendingId }: MultisigVotePanelProps) {
  const { wallets, selected, setSelected } = useCardanoWallets();
  const enabledApiRef = useRef<EnabledWalletApi | null>(null);

  // Shared error surface.
  const [error, setError] = useState<string | null>(null);

  // ---- initiate-mode state ----
  const [vote, setVote] = useState<VoteChoice>('yes');
  // Which vote option currently holds keyboard focus, so its label can render a
  // focus ring (the visually hidden radio's own outline is not visible).
  const [voteFocused, setVoteFocused] = useState<VoteChoice | null>(null);
  const [rationaleText, setRationaleText] = useState('');
  const [rationaleModalOpen, setRationaleModalOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  // Set once the pending vote is created in initiate mode; carries the id used
  // to build the share link and to poll progress.
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Open votes fetched from /api/drep/multisig/list (initiate mode only).
  const [openVotes, setOpenVotes] = useState<Array<{ id: string; gaId: string; vote: string; expiresAt: number }>>([]);

  // ---- witness/submit state (and initiate progress after creation) ----
  const [pending, setPending] = useState<PendingState | null>(null);
  const [signerPaste, setSignerPaste] = useState('');
  const [addingWitness, setAddingWitness] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedTxHash, setSubmittedTxHash] = useState<string | null>(null);

  // The id this component tracks: the pending id passed in (witness mode) or the
  // id created here (initiate mode).
  const trackedId = pendingId || createdId;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  // ---- connect the wallet (funding only) ----
  const connectWallet = useCallback(async (): Promise<EnabledWalletApi | null> => {
    if (enabledApiRef.current) return enabledApiRef.current;
    const walletInfo = wallets.find((w) => w.key === selected);
    if (!walletInfo) {
      setError('Select a wallet to continue.');
      return null;
    }
    let api: EnabledWalletApi;
    try {
      api = (await walletInfo.raw.enable({ extensions: [{ cip: 95 }] })) as unknown as EnabledWalletApi;
    } catch (err) {
      setError(readableError(err));
      return null;
    }
    try {
      await assertWalletNetwork(api, network);
    } catch (err) {
      setError(readableError(err));
      return null;
    }
    enabledApiRef.current = api;
    rememberWallet(selected);
    return api;
  }, [wallets, selected, network]);

  // ---- poll the pending state ----
  const refresh = useCallback(async () => {
    if (!trackedId) return;
    try {
      const res = await fetchWithTimeout(`/api/drep/multisig/${trackedId}`);
      if (!res.ok) return;
      const data = (await res.json()) as PendingState;
      setPending(data);
    } catch {
      // Transient read errors are non-fatal; the next poll retries.
    }
  }, [trackedId]);

  // Poll while there is a tracked id and no final tx hash yet.
  useEffect(() => {
    if (!trackedId || submittedTxHash) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [trackedId, submittedTxHash, refresh]);

  // Fetch open pending votes once on mount (initiate mode only, before a vote is created).
  useEffect(() => {
    if (mode !== 'initiate' || createdId) return;
    fetch('/api/drep/multisig/list')
      .then((r) => (r.ok ? (r.json() as Promise<{ items: typeof openVotes }>) : Promise.resolve({ items: [] })))
      .then((body) => setOpenVotes(body.items))
      .catch(() => {
        // Non-fatal: the list is a convenience only.
      });
  }, [mode, createdId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- initiate: build + store the pending vote ----
  async function handleInitiate() {
    setError(null);
    setBuilding(true);
    try {
      const api = await connectWallet();
      if (!api) {
        setBuilding(false);
        return;
      }

      // Host the rationale first (when present) so its anchor lands in the tx.
      let anchor: { url: string; hash: string } | undefined;
      if (rationaleText.trim()) {
        const res = await fetchWithTimeout('/api/vote/rationale', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ drepId: scriptDrepId, gaId, rationale: rationaleText }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ? `Could not host rationale: ${body.error}.` : 'Could not host the vote rationale. Please try again.');
        }
        anchor = (await res.json()) as { url: string; hash: string };
      }

      // Fetch the native script for this script DRep from the Koios proxy.
      const parsed = parseDrepId(scriptDrepId);
      if (parsed?.kind !== 'script') {
        throw new Error('This DRep is not a native-script DRep.');
      }
      const scriptRes = await fetchWithTimeout('/api/koios/script_info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _script_hashes: [parsed.hashHex] }),
      });
      if (!scriptRes.ok) {
        throw new Error('Could not load the multisig script. Please try again.');
      }
      const scriptRows = (await scriptRes.json()) as Array<{ value?: unknown }>;
      const scriptValue = Array.isArray(scriptRows) ? scriptRows[0]?.value : undefined;
      const { parseNativeScriptJson } = await import('@/lib/cardano/nativeScript.js');
      const nativeScript = parseNativeScriptJson(scriptValue);
      if (!nativeScript) {
        throw new Error('This DRep is not controlled by a supported native script.');
      }

      // Build the unsigned, funded tx client-side (heavy SDK, lazy-imported).
      const { buildScriptDRepVoteTx } = await import('@/lib/governance/scriptVoteTx.js');
      const { unsignedTxHex, bodyHashHex } = await buildScriptDRepVoteTx({
        walletApi: api,
        network,
        scriptDrepId,
        nativeScript,
        govActionId: gaId,
        vote,
        anchorUrl: anchor?.url,
        anchorHashHex: anchor?.hash,
        origin,
      });

      // Store it and surface the share link + progress.
      const storeRes = await fetchWithTimeout('/api/drep/multisig', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scriptDrepId,
          gaId,
          vote,
          unsignedTxCbor: unsignedTxHex,
          bodyHash: bodyHashHex,
          anchorUrl: anchor?.url,
          anchorHashHex: anchor?.hash,
        }),
      });
      if (!storeRes.ok) {
        const body = (await storeRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ? `Could not store the vote: ${body.error}.` : 'Could not store the vote. Please try again.');
      }
      const { id } = (await storeRes.json()) as { id: string };
      setCreatedId(id);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBuilding(false);
    }
  }

  // ---- witness: build the witness-set hex client-side from cardano-signer ----
  async function handleAddWitness() {
    if (!trackedId) return;
    setError(null);
    setAddingWitness(true);
    try {
      // cardano-signer's `sign --data-hex` prints JSON with hex signature +
      // publicKey. Accept the whole JSON object, or a bare {signature, publicKey}.
      let signature: string;
      let publicKey: string;
      try {
        const obj = JSON.parse(signerPaste.trim()) as { signature?: unknown; publicKey?: unknown };
        if (typeof obj.signature !== 'string' || typeof obj.publicKey !== 'string') {
          throw new Error('missing fields');
        }
        signature = obj.signature.trim();
        publicKey = obj.publicKey.trim();
      } catch {
        throw new Error('Paste the full JSON output from cardano-signer (it must contain "signature" and "publicKey").');
      }

      // Assemble a single-witness set hex (lazy SDK import).
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

      const res = await fetchWithTimeout(`/api/drep/multisig/${trackedId}/witness`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ witnessSetHex }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ? `Could not add signature: ${body.error}.` : 'Could not add the signature. Please try again.');
      }
      setSignerPaste('');
      await refresh();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setAddingWitness(false);
    }
  }

  // ---- submit: assemble server-side, then fund + submit from the wallet ----
  async function handleSubmit() {
    if (!trackedId) return;
    setError(null);
    setSubmitting(true);
    try {
      // Server folds the collected member witnesses into the unsigned tx.
      const assembleRes = await fetchWithTimeout(`/api/drep/multisig/${trackedId}/submit`, { method: 'POST' });
      if (!assembleRes.ok) {
        const body = (await assembleRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ? `Could not assemble the vote: ${body.error}.` : 'Could not assemble the vote. Please try again.');
      }
      const { assembledTxHex } = (await assembleRes.json()) as { assembledTxHex: string };

      // Only the funding wallet can sign the tx inputs, so the submit must run
      // from the same wallet that built the tx.
      const api = await connectWallet();
      if (!api) {
        setSubmitting(false);
        return;
      }

      const { Transaction } = await import('@evolution-sdk/evolution');
      const fundingWs = await api.signTx(assembledTxHex, true);
      const finalTx = Transaction.addVKeyWitnessesHex(assembledTxHex, fundingWs);
      const txHash = await api.submitTx(finalTx);

      await fetchWithTimeout(`/api/drep/multisig/${trackedId}/submitted`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txHash }),
      });
      setSubmittedTxHash(txHash);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // ------------------------------------------------------------------
  // Render: success (vote submitted)
  // ------------------------------------------------------------------
  if (submittedTxHash) {
    return (
      <div style={{ maxWidth: '32rem' }}>
        <div className="callout callout--success" role="status">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Vote submitted</p>
            <p style={{ margin: '0 0 0.5rem', overflowWrap: 'anywhere' }}>
              Transaction:{' '}
              <a href={txExplorerUrl(network, submittedTxHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
                {submittedTxHash}
              </a>
              <CopyIdButton value={submittedTxHash} label="Copy transaction hash" />
            </p>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
              The vote will appear on-chain once the transaction is confirmed.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Shared: the submit step, shown once the script is satisfied.
  // ------------------------------------------------------------------
  const submitStep = pending?.satisfied && pending.status === 'collecting' && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
      <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
        Enough signatures are collected. The wallet that funded the build must complete the submission, because it owns the transaction inputs.
      </p>
      {wallets.length === 0 ? (
        <p style={{ color: 'var(--muted)', margin: 0, fontSize: '0.875rem' }}>
          No Cardano wallet extension detected. Open this on the funding wallet's device (e.g. Lace, Eternl, Typhon).
        </p>
      ) : (
        <>
          <WalletConnection wallets={wallets} selected={selected} onSelect={setSelected} disabled={submitting} label="Funding wallet" />
          <button type="button" className="btn btn-primary" onClick={() => void handleSubmit()} disabled={submitting} style={{ alignSelf: 'flex-start' }}>
            {submitting ? 'Submitting...' : 'Submit vote'}
          </button>
        </>
      )}
    </div>
  );

  // ------------------------------------------------------------------
  // Render: witness mode (the cosign page).
  // ------------------------------------------------------------------
  if (mode === 'witness') {
    if (!pending) {
      return (
        <div style={{ maxWidth: '32rem' }}>
          {error ? <ErrorCallout message={error} /> : <p style={{ color: 'var(--muted)', margin: 0 }}>Loading the pending vote...</p>}
        </div>
      );
    }

    if (pending.status !== 'collecting' && !submittedTxHash) {
      return (
        <div style={{ maxWidth: '32rem' }}>
          <div className="callout callout--info" role="status">
            <div className="callout__body">
              <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>This vote has already been submitted.</p>
              {pending.txHash && (
                <a href={txExplorerUrl(network, pending.txHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
                  View transaction
                </a>
              )}
              {pending.txHash && <CopyIdButton value={pending.txHash} label="Copy transaction hash" />}
            </div>
          </div>
        </div>
      );
    }

    const command = `cardano-signer sign --data-hex ${pending.bodyHash} --secret-key drep.skey`;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '36rem' }}>
        <div>
          <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>
            Cast {pending.vote.toUpperCase()} on governance action
          </p>
          <p style={{ margin: '0 0 0.35rem', fontSize: '0.8125rem', color: 'var(--muted)', wordBreak: 'break-all' }}>
            {pending.gaId}
            <CopyIdButton value={pending.gaId} label="Copy governance action id" />
          </p>
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)', wordBreak: 'break-all' }}>
            as {pending.drepId}
            <CopyIdButton value={pending.drepId} label="Copy DRep id" />
          </p>
        </div>

        <ProgressLine pending={pending} />

        {!pending.satisfied && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 500 }}>Add your signature</p>
            <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>
              Sign the transaction body hash offline with your DRep key, then paste the output below. A browser wallet cannot produce a script member's DRep witness.
            </p>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
              <pre style={{ ...monoBlockStyle, flex: 1 }}>{command}</pre>
              <CopyButton text={command} />
            </div>
            <textarea
              value={signerPaste}
              onChange={(e) => setSignerPaste(e.target.value)}
              placeholder='Paste the cardano-signer JSON output here, e.g. { "signature": "...", "publicKey": "..." }'
              rows={5}
              disabled={addingWitness}
              style={{
                width: '100%',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8125rem',
                padding: '0.625rem 0.75rem',
                border: '1px solid var(--border)',
                borderRadius: '0.375rem',
                background: 'var(--bg)',
                color: 'var(--fg)',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleAddWitness()}
              disabled={addingWitness || !signerPaste.trim()}
              style={{ alignSelf: 'flex-start' }}
            >
              {addingWitness ? 'Adding...' : 'Add signature'}
            </button>
          </div>
        )}

        {submitStep}
        {error && <ErrorCallout message={error} />}
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Render: initiate mode, after the pending vote was created.
  // ------------------------------------------------------------------
  if (createdId) {
    const cosignLink = `${origin}/drep/cosign/${createdId}`;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '32rem' }}>
        <div className="callout callout--success" role="status">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div className="callout__body">
            <p style={{ margin: '0 0 0.35rem', fontWeight: 600 }}>Vote created</p>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
              Share this link with the other script members so they can co-sign.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
          <pre style={{ ...monoBlockStyle, flex: 1 }}>{cosignLink}</pre>
          <CopyButton text={cosignLink} label="Copy link" />
        </div>

        {pending && <ProgressLine pending={pending} />}
        {submitStep}
        {error && <ErrorCallout message={error} />}
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Render: initiate mode, the vote form.
  // ------------------------------------------------------------------
  return (
    <div style={{ maxWidth: '32rem' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--muted)' }}>
          This is a multisig DRep. Start the vote, then share the co-sign link with the other members.
        </p>

        {/* Vote choice */}
        <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend style={{ fontSize: '0.875rem', color: 'var(--muted)', marginBottom: '0.5rem', fontWeight: 500 }}>Your vote</legend>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {(['yes', 'no', 'abstain'] as const).map((v) => (
              <label
                key={v}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  padding: '0.5rem 1rem',
                  border: `1px solid ${vote === v ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: '0.375rem',
                  cursor: building ? 'not-allowed' : 'pointer',
                  fontWeight: vote === v ? 600 : 400,
                  color: vote === v ? 'var(--accent)' : 'inherit',
                  background: vote === v ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                  opacity: building ? 0.7 : 1,
                  textTransform: 'capitalize',
                  outline: voteFocused === v ? '2px solid var(--accent)' : 'none',
                  outlineOffset: 2,
                }}
              >
                <input type="radio" name="multisig-vote" value={v} checked={vote === v} onChange={() => setVote(v)} onFocus={() => setVoteFocused(v)} onBlur={() => setVoteFocused(null)} disabled={building} style={srOnlyRadio} />
                {v}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Rationale (optional) */}
        <div>
          <span style={{ display: 'block', fontSize: '0.875rem', color: 'var(--muted)', fontWeight: 500, marginBottom: '0.375rem' }}>
            Rationale <span style={{ fontWeight: 400 }}>(optional, published on-chain as CIP-100)</span>
          </span>
          {rationaleText.trim() ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.875rem' }}>Rationale added, {rationaleText.length} characters.</span>
              <button type="button" onClick={() => setRationaleModalOpen(true)} disabled={building} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: building ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}>
                Edit
              </button>
              <button type="button" onClick={() => setRationaleText('')} disabled={building} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: building ? 'not-allowed' : 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}>
                Remove
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setRationaleModalOpen(true)} disabled={building} style={{ padding: '0.5rem 0.875rem', border: '1px solid var(--border)', borderRadius: '0.375rem', background: 'var(--bg)', color: 'var(--fg)', cursor: building ? 'not-allowed' : 'pointer', fontSize: '0.875rem' }}>
              Write a rationale
            </button>
          )}
        </div>

        {/* Connect + build */}
        {wallets.length === 0 ? (
          <p style={{ color: 'var(--muted)', margin: 0 }}>
            No Cardano wallet extension detected. Please install one (e.g. Lace, Eternl, Typhon).
          </p>
        ) : (
          <>
            <WalletConnection wallets={wallets} selected={selected} onSelect={setSelected} disabled={building} label="Funding wallet" />
            <button type="button" className="btn btn-primary" onClick={() => void handleInitiate()} disabled={building} style={{ alignSelf: 'flex-start' }}>
              {building ? 'Building...' : 'Start vote'}
            </button>
            {building && (
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }}>
                Building and funding the transaction. Please approve any wallet prompt.
              </p>
            )}
          </>
        )}

        {error && <ErrorCallout message={error} />}
      </div>

      {/* Open multisig votes: list below the form so members can find pending co-signs. */}
      {openVotes.length > 0 && (
        <div style={{ marginTop: '1.25rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem', fontWeight: 500 }}>
            Open multisig votes
          </p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {openVotes.map((item) => (
              <li key={item.id} style={{ fontSize: '0.8125rem', display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
                <a
                  href={`/drep/cosign/${item.id}/`}
                  style={{ color: 'var(--accent)', textDecoration: 'underline', wordBreak: 'break-all' }}
                >
                  {item.vote.toUpperCase()} on {item.gaId}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rationaleModalOpen && (
        <RationaleModal value={rationaleText} onChange={setRationaleText} onClose={() => setRationaleModalOpen(false)} />
      )}
    </div>
  );
}
