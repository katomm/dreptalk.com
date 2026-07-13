// Roomy modal for writing a vote rationale, using the same Markdown editor as
// the forum composer (toolbar + preview). It only composes text: the value is
// bound to the caller's rationale state, and closing keeps whatever was typed.
// The vote itself is cast from the panel, not here. Dialog mechanics (backdrop,
// Escape, outside-click close) mirror DelegateDialog.
import { useRef } from 'react';
import MarkdownEditor, { type MarkdownEditorHandle } from '@/components/MarkdownEditor.js';
import { MAX_VOTE_RATIONALE } from '@/lib/governance/voteRationale.js';
import { useDialogA11y } from '@/components/useDialogA11y.js';

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

  // Escape / outside-click close, body-scroll lock, focus trap, focus restore on
  // close, and initial focus on the editor so typing starts immediately.
  useDialogA11y({ panelRef, onClose, lockScroll: true, initialFocusRef: editorRef });

  return (
    <div className="drep-dialog__backdrop">
      <div ref={panelRef} className="drep-dialog drep-dialog--wide" role="dialog" aria-modal="true" aria-labelledby="rationale-dialog-title" tabIndex={-1}>
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
