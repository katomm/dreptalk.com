import { forwardRef, useImperativeHandle, useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { applyMarkdown, type MarkdownAction } from '@/lib/forum/markdownToolbar.js';

// Toolbar buttons: label is what shows in the button, title is the tooltip.
const TOOLBAR: { action: MarkdownAction; label: string; title: string }[] = [
  { action: 'bold', label: 'B', title: 'Bold' },
  { action: 'italic', label: 'I', title: 'Italic' },
  { action: 'heading', label: 'H', title: 'Heading' },
  { action: 'link', label: '\u{1F517}', title: 'Link' },
  { action: 'quote', label: '"', title: 'Quote' },
  { action: 'list', label: '•', title: 'List' },
  { action: 'code', label: '<>', title: 'Code' },
];

export interface MarkdownEditorHandle {
  focus(): void;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  minRows?: number;
  idPrefix?: string;
  showCounter?: boolean;
  helpText?: boolean;
}

// Controlled Markdown editor shared by the forum composer and the vote rationale
// modal. Toolbar + textarea + a Preview toggle backed by /api/preview (server
// sanitized). The imperative focus() handle resets to edit mode and focuses the
// textarea, which the composer uses when a Reply/Edit action targets it.
const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(
  { value, onChange, maxLength, label, placeholder = 'Write in Markdown...', disabled = false, required = false, minRows = 7, idPrefix = 'md', showCounter = false, helpText = true },
  ref,
) {
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSelRef = useRef<{ start: number; end: number } | null>(null);
  const bodyId = `${idPrefix}-body`;

  useImperativeHandle(ref, () => ({
    focus() {
      setShowPreview(false);
      // Defer to after the edit-mode re-render so the textarea exists.
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  }), []);

  const runAction = useCallback(
    (action: MarkdownAction) => {
      const el = textareaRef.current;
      if (!el) return;
      const next = applyMarkdown({ text: value, start: el.selectionStart, end: el.selectionEnd }, action);
      pendingSelRef.current = { start: next.start, end: next.end };
      onChange(next.text);
    },
    [value, onChange],
  );

  // Restore focus + selection after a toolbar edit updates the value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the intended re-run trigger (restore caret after the value updates), not read in the effect body
  useLayoutEffect(() => {
    const sel = pendingSelRef.current;
    if (!sel || !textareaRef.current) return;
    pendingSelRef.current = null;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(sel.start, sel.end);
  }, [value]);

  const fetchPreview = useCallback(async (md: string) => {
    if (!md.trim()) {
      setPreviewHtml('');
      return;
    }
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bodyMd: md }),
      });
      if (res.ok) {
        const data = (await res.json()) as { html: string };
        setPreviewHtml(data.html);
      }
    } catch {
      // Preview errors are silent; the user can still compose.
    }
  }, []);

  useEffect(() => {
    if (!showPreview) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchPreview(value);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, showPreview, fetchPreview]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
        {label ? (
          <label htmlFor={bodyId} style={{ fontSize: '0.875rem', color: 'var(--muted)' }}>{label}</label>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => setShowPreview((p) => !p)}
          style={{ fontSize: '0.8125rem', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          {showPreview ? 'Edit' : 'Preview'}
        </button>
      </div>

      {showPreview ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: previewHtml is server-sanitized markdown (renderMarkdown in src/lib/markdown.ts, via /api/preview)
        <div dangerouslySetInnerHTML={{ __html: previewHtml || '<p style="color:var(--muted)">Nothing to preview yet.</p>' }}
          className="prose"
          style={{ minHeight: '7rem', padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: '0.375rem', fontSize: '0.9375rem', lineHeight: '1.6', overflowWrap: 'break-word' }}
        />
      ) : (
        <>
          <div role="toolbar" aria-label="Markdown formatting" style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.375rem', flexWrap: 'wrap' }}>
            {TOOLBAR.map(({ action, label: btnLabel, title }) => (
              <button
                key={action}
                type="button"
                title={title}
                aria-label={title}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runAction(action)}
                style={{ minWidth: '2rem', height: '2rem', padding: '0 0.5rem', border: '1px solid var(--border)', borderRadius: '0.375rem', background: 'var(--bg)', color: 'var(--fg)', fontSize: '0.875rem', fontWeight: action === 'bold' ? 700 : 500, fontStyle: action === 'italic' ? 'italic' : 'normal', cursor: disabled ? 'not-allowed' : 'pointer', lineHeight: 1 }}
              >
                {btnLabel}
              </button>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            id={bodyId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            required={required}
            disabled={disabled}
            rows={minRows}
            style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: '0.375rem', background: 'var(--bg)', color: 'var(--fg)', fontSize: '0.9375rem', lineHeight: '1.6', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
          {showCounter && (
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: value.length > maxLength * 0.9 ? 'var(--accent)' : 'var(--muted)', textAlign: 'right' }}>
              {value.length} / {maxLength}
            </p>
          )}
        </>
      )}

      {helpText && (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
          Use the toolbar or type Markdown directly: headings, bold, italics, links, quotes, lists, and code.
        </p>
      )}
    </div>
  );
});

export default MarkdownEditor;
