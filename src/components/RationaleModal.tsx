// Roomy modal for writing a vote rationale, using the same Markdown editor as
// the forum composer (toolbar + preview). It only composes text: the value is
// bound to the caller's rationale state, and closing keeps whatever was typed.
// The vote itself is cast from the panel, not here. Dialog mechanics (backdrop,
// Escape, outside-click close) mirror DelegateDialog.
import { useEffect, useRef } from 'react';
import MarkdownEditor, { type MarkdownEditorHandle } from '@/components/MarkdownEditor.js';
import { MAX_VOTE_RATIONALE } from '@/lib/governance/voteRationale.js';

export default function RationaleModal({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);

  // Escape or a click outside the panel closes. Mirrors DelegateDialog: an
  // outside-click is a document mousedown test against the panel, not a backdrop
  // onClick, so the backdrop stays free of interaction handlers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  // Lock body scroll while open (restored on close).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus the editor on open so typing starts immediately.
  useEffect(() => {
    editorRef.current?.focus();
  }, []);

  return (
    <div className="drep-dialog__backdrop">
      <div ref={panelRef} className="drep-dialog drep-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="rationale-dialog-title">
        <div className="drep-dialog__head">
          <h2 id="rationale-dialog-title" className="drep-dialog__title">Write your vote rationale</h2>
          <button type="button" className="drep-dialog__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="drep-dialog__note">
          Optional. Published on-chain with your vote (CIP-100) and shown as a post on this action. Markdown is supported.
        </p>

        <MarkdownEditor
          ref={editorRef}
          value={value}
          onChange={onChange}
          maxLength={MAX_VOTE_RATIONALE}
          placeholder="Explain your vote (Markdown supported)..."
          minRows={12}
          idPrefix="rationale"
          showCounter
          helpText={false}
        />

        <div style={{ marginTop: '1rem' }}>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
