// The Review step of /ga/new: the action as it will be rendered, over the
// form, before anything is published or signed.
//
// A native <dialog> opened with showModal(), so the browser supplies the
// top-layer stacking, the backdrop and the inert page behind it. Escape and
// an explicit Edit button both close it and put focus back on the Review
// button, and the body cannot scroll while it is open. A real focus trap and
// the Tab order inside are a later task, the browser's own modal behaviour
// covers the common case in the meantime.
//
// One round trip per open: the three Markdown fields go to /api/preview in a
// single request, and nothing else is fetched. A failure says so and offers a
// retry, never blocking the form underneath.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { fetchWithTimeout } from '@/lib/http/fetchWithTimeout.js';
import PreviewCard from '@/components/govAction/PreviewCard.js';
import type { OnchainChanges } from '@/lib/governance/onchain.js';

export interface ReviewModalProps {
  open: boolean;
  /** Closes the modal. The caller returns focus to the Review button. */
  onClose: () => void;
  title: string;
  abstractMd: string;
  motivationMd: string;
  rationaleMd: string;
  authorLine: string;
  missing: string[];
  references: readonly { label: string; uri: string }[];
  onchain: OnchainChanges | null;
  committeeNames?: Map<string, string>;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; html: { abstract?: string; motivation?: string; rationale?: string } }
  | { status: 'error'; message: string };

const dialogStyle: CSSProperties = {
  width: 'min(46rem, calc(100vw - 2rem))',
  maxHeight: 'calc(100vh - 4rem)',
  padding: 0,
  border: '1px solid var(--border)',
  borderRadius: '0.625rem',
  background: 'var(--bg)',
  color: 'var(--fg)',
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  padding: '0.875rem 1.125rem',
  borderBottom: '1px solid var(--border)',
};

const bodyStyle: CSSProperties = {
  padding: '1.125rem',
  overflowY: 'auto',
  maxHeight: 'calc(100vh - 9rem)',
};

export default function ReviewModal(props: ReviewModalProps) {
  const { open, onClose, abstractMd, motivationMd, rationaleMd } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  // Bumped by Retry so the fetch effect runs again for the same open modal.
  const [attempt, setAttempt] = useState(0);

  // Monotonic id per request, so only the latest one may file its answer.
  // Open, Edit, change a field, open again: if the first request answers last
  // it would otherwise paint the old text over the new preview. Closing bumps
  // it too, so a request still in flight cannot reopen a stale modal.
  const requestIdRef = useRef(0);

  // The one round trip. The fields go as they are typed, the server trims,
  // renders and links them exactly as it does for the action page.
  const load = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const stale = () => requestIdRef.current !== requestId;
    setPreview({ status: 'loading' });
    try {
      const res = await fetchWithTimeout(`${window.location.origin}/api/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: { abstract: abstractMd, motivation: motivationMd, rationale: rationaleMd },
        }),
      });
      if (stale()) return;
      if (!res.ok) {
        // A 400 is ours to explain: the fields are over what the route takes,
        // which the user can act on, unlike a 500 or a dropped connection.
        const message =
          res.status === 400
            ? 'The text is too long to preview. Shorten a field and try again.'
            : 'Preview unavailable, the form is unaffected.';
        setPreview({ status: 'error', message });
        return;
      }
      const data = (await res.json()) as { html?: Record<string, string> };
      if (stale()) return;
      setPreview({ status: 'ready', html: data.html ?? {} });
    } catch {
      if (stale()) return;
      setPreview({ status: 'error', message: 'Preview unavailable, the form is unaffected.' });
    }
  }, [abstractMd, motivationMd, rationaleMd]);

  // Open and close the native dialog, and lock the page behind it. The lock is
  // restored to whatever the page had, not blanked, so a future global style
  // on body survives a preview.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      // Anything still in flight belongs to the preview being closed.
      requestIdRef.current += 1;
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Fetch once per open, and once more per Retry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry nonce, it exists to re-run this for the same open modal
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, attempt, load]);

  // The element stays mounted and is opened and closed through the dialog API,
  // never by unmounting: tearing a showModal()'d dialog out of the tree leaves
  // the browser holding a top-layer entry for a node that is gone.
  return (
    <dialog
      ref={dialogRef}
      aria-label="Review the governance action"
      style={dialogStyle}
      // Escape reaches us two ways: the browser's own `cancel` event, and the
      // keydown handler, which is what closes the dialog in environments whose
      // showModal() is a stub (happy-dom, and the tests that run on it). Both
      // route through the one onClose, and a second call is a no-op.
      onCancel={e => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {/* Closed content stays out of the tree: a closed dialog is display:none
          in a browser, and nothing offscreen should be reachable meanwhile. */}
      {open && (
        <>
          <div style={headerStyle}>
            <h2 style={{ margin: 0, fontSize: '1.0625rem' }}>Review</h2>
            <button type="button" className="btn" onClick={onClose}>
              Edit
            </button>
          </div>

          <div style={bodyStyle}>
            {preview.status === 'loading' && (
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '0.875rem' }} role="status">
                Rendering the preview...
              </p>
            )}

            {preview.status === 'error' && (
              <div className="callout callout--error" role="alert">
                <div className="callout__body">
                  {preview.message}{' '}
                  <button
                    type="button"
                    onClick={() => setAttempt(n => n + 1)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--accent)',
                      cursor: 'pointer',
                      padding: 0,
                      font: 'inherit',
                      textDecoration: 'underline',
                    }}
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {preview.status === 'ready' && (
              <PreviewCard
                title={props.title}
                html={preview.html}
                motivationMd={motivationMd}
                rationaleMd={rationaleMd}
                authorLine={props.authorLine}
                missing={props.missing}
                references={props.references}
                onchain={props.onchain}
                committeeNames={props.committeeNames}
              />
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
