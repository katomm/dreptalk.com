import { forwardRef, useImperativeHandle, useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { applyMarkdown, type MarkdownAction } from '@/lib/forum/markdownToolbar.js';
import { detectMentionQuery, filterCandidates, insertMention, type ActiveMention } from '@/lib/forum/mentionAutocomplete.js';
import type { MentionCandidate } from '@/lib/db/mentionCandidates.js';

// Fetched once per page; the candidate set is small and edge-cached.
let candidatesPromise: Promise<MentionCandidate[]> | null = null;
function loadCandidates(): Promise<MentionCandidate[]> {
  candidatesPromise ??= fetch('/api/mention-candidates')
    .then((res) => (res.ok ? (res.json() as Promise<{ candidates: MentionCandidate[] }>) : { candidates: [] }))
    .then((data) => data.candidates)
    .catch(() => {
      // Allow a retry on the next '@' instead of caching a transient failure.
      candidatesPromise = null;
      return [];
    });
  return candidatesPromise;
}

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
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Aborts the in-flight preview request so a slower older response can never
  // overwrite a newer one (fast typing), and is cancelled on unmount.
  const previewAbortRef = useRef<AbortController | null>(null);
  // True until the first fetch after opening preview, so that toggle renders
  // immediately while later keystrokes still debounce.
  const firstPreviewRef = useRef(true);
  const pendingSelRef = useRef<{ start: number; end: number } | null>(null);
  const bodyId = `${idPrefix}-body`;

  // @mention autocomplete: candidates load lazily on the first '@', the panel
  // sits below the textarea (not caret-anchored).
  const [candidates, setCandidates] = useState<MentionCandidate[] | null>(null);
  const [active, setActive] = useState<ActiveMention | null>(null);
  const [highlight, setHighlight] = useState(0);
  // Escape/Enter/Tab change `active` directly; the keyup that follows the same
  // physical keypress must not immediately re-run syncActive against the
  // not-yet-rerendered textarea and undo that (e.g. reopen the panel right
  // after Escape closed it).
  const suppressKeyUpRef = useRef(false);

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

  // Recomputes the active @mention from the caret position; called after any
  // change to the textarea value or caret so the panel tracks typing and
  // caret movement. Candidates are fetched lazily on the first '@'.
  const syncActive = (el: HTMLTextAreaElement) => {
    const next = detectMentionQuery(el.value, el.selectionStart);
    if (next?.start !== active?.start || next?.query !== active?.query) setHighlight(0);
    setActive(next);
    if (next && candidates === null) void loadCandidates().then(setCandidates);
  };

  const suggestions = active && candidates ? filterCandidates(candidates, active.query) : [];
  const panelOpen = active !== null && suggestions.length > 0;

  // Replaces the active mention with the chosen slug and restores the caret
  // afterward, reusing the same pendingSelRef mechanism the toolbar actions use.
  const acceptSuggestion = (cand: MentionCandidate) => {
    const el = textareaRef.current;
    if (!el || !active) return;
    const next = insertMention(value, active, el.selectionStart, cand.slug);
    pendingSelRef.current = { start: next.caret, end: next.caret };
    setActive(null);
    onChange(next.text);
  };

  const fetchPreview = useCallback(async (md: string) => {
    // Supersede any in-flight preview so an older, slower response cannot land
    // after a newer one and show stale HTML.
    previewAbortRef.current?.abort();
    if (!md.trim()) {
      setPreviewHtml('');
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    previewAbortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bodyMd: md }),
        signal: ctrl.signal,
      });
      if (!ctrl.signal.aborted && res.ok) {
        const data = (await res.json()) as { html: string };
        if (!ctrl.signal.aborted) setPreviewHtml(data.html);
      }
    } catch {
      // Preview errors (including the AbortError on supersede) are silent; the
      // user can still compose.
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  // Cancel any in-flight preview when the editor unmounts.
  useEffect(() => () => previewAbortRef.current?.abort(), []);

  // Re-arm the immediate-render flag whenever preview closes, so the next open
  // fetches without waiting on the debounce.
  useEffect(() => {
    if (!showPreview) firstPreviewRef.current = true;
  }, [showPreview]);

  useEffect(() => {
    if (!showPreview) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // First fetch after opening preview is instant; subsequent keystrokes debounce.
    const delay = firstPreviewRef.current ? 0 : 400;
    firstPreviewRef.current = false;
    debounceRef.current = setTimeout(() => {
      void fetchPreview(value);
    }, delay);
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
        <div dangerouslySetInnerHTML={{ __html: previewHtml || `<p style="color:var(--muted)">${loading ? 'Loading preview...' : 'Nothing to preview yet.'}</p>` }}
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
            onChange={(e) => {
              onChange(e.target.value);
              syncActive(e.target);
            }}
            onKeyDown={(e) => {
              if (!panelOpen) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => (h + 1) % suggestions.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                suppressKeyUpRef.current = true;
                acceptSuggestion(suggestions[highlight]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                suppressKeyUpRef.current = true;
                setActive(null);
              }
            }}
            onKeyUp={(e) => {
              if (suppressKeyUpRef.current) {
                suppressKeyUpRef.current = false;
                return;
              }
              syncActive(e.currentTarget);
            }}
            onClick={(e) => syncActive(e.currentTarget)}
            onBlur={() => setActive(null)}
            placeholder={placeholder}
            maxLength={maxLength}
            required={required}
            disabled={disabled}
            rows={minRows}
            style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid var(--border)', borderRadius: '0.375rem', background: 'var(--bg)', color: 'var(--fg)', fontSize: '0.9375rem', lineHeight: '1.6', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
          {active !== null && suggestions.length > 0 && (
            <div
              role="listbox"
              aria-label="Mention suggestions"
              style={{ margin: '0.25rem 0 0', padding: '0.25rem', border: '1px solid var(--border)', borderRadius: '0.375rem', background: 'var(--bg)', maxHeight: '14rem', overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.12)' }}
            >
              {suggestions.map((cand, i) => (
                <button
                  key={cand.slug}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => acceptSuggestion(cand)}
                  onMouseEnter={() => setHighlight(i)}
                  style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', width: '100%', padding: '0.35rem 0.5rem', border: 'none', borderRadius: '0.25rem', background: i === highlight ? 'var(--surface)' : 'transparent', color: 'var(--fg)', cursor: 'pointer', textAlign: 'left', fontSize: '0.875rem' }}
                >
                  <span style={{ fontWeight: 600 }}>{cand.name}</span>
                  <span style={{ color: 'var(--muted)', fontSize: '0.8125rem' }}>@{cand.slug}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{cand.kind === 'drep' ? 'DRep' : 'SPO'}</span>
                </button>
              ))}
            </div>
          )}
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
