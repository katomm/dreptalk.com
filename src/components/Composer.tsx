import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { submitComposer } from '@/lib/forum/composer.js';
import { applyMarkdown, type MarkdownAction } from '@/lib/forum/markdownToolbar.js';

// Toolbar buttons: label is what shows in the button, title is the tooltip.
const TOOLBAR: { action: MarkdownAction; label: string; title: string }[] = [
  { action: 'bold', label: 'B', title: 'Bold' },
  { action: 'italic', label: 'I', title: 'Italic' },
  { action: 'heading', label: 'H', title: 'Heading' },
  { action: 'link', label: '\u{1F517}', title: 'Link' },
  { action: 'quote', label: '”', title: 'Quote' },
  { action: 'list', label: '•', title: 'List' },
  { action: 'code', label: '<>', title: 'Code' },
];

interface ComposerProps {
  mode: 'topic' | 'post';
  categorySlug?: string;
  topicId?: string;
}

/** Detail of the page-level reply event dispatched by a post's Reply button. */
interface ReplyEventDetail {
  postId: string;
  author: string;
}

export default function Composer({ mode, categorySlug, topicId }: ComposerProps) {
  const [title, setTitle] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  // Reply target set by a post's Reply button (one-level threading).
  const [replyTo, setReplyTo] = useState<ReplyEventDetail | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Selection to restore after a toolbar edit re-renders the textarea.
  const pendingSelRef = useRef<{ start: number; end: number } | null>(null);

  // The Reply buttons live in server-rendered markup (no island), so they talk
  // to the composer via a window event. Scroll the form into view and focus the
  // textarea so the click lands the user where they can type.
  useEffect(() => {
    if (mode !== 'post') return;
    const onReply = (e: Event) => {
      const detail = (e as CustomEvent<ReplyEventDetail>).detail;
      if (!detail?.postId) return;
      setReplyTo(detail);
      setShowPreview(false);
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      textareaRef.current?.focus();
    };
    window.addEventListener('dreptalk:reply', onReply);
    return () => window.removeEventListener('dreptalk:reply', onReply);
  }, [mode]);

  // Apply a toolbar action to the current textarea selection.
  const runAction = useCallback(
    (action: MarkdownAction) => {
      const el = textareaRef.current;
      if (!el) return;
      const next = applyMarkdown({ text: bodyMd, start: el.selectionStart, end: el.selectionEnd }, action);
      pendingSelRef.current = { start: next.start, end: next.end };
      setBodyMd(next.text);
    },
    [bodyMd],
  );

  // Restore focus and selection after a toolbar edit updates the value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bodyMd is the intended re-run trigger (restore caret after the value updates), not read in the effect body
  useLayoutEffect(() => {
    const sel = pendingSelRef.current;
    if (!sel || !textareaRef.current) return;
    pendingSelRef.current = null;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(sel.start, sel.end);
  }, [bodyMd]);

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
      void fetchPreview(bodyMd);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [bodyMd, showPreview, fetchPreview]);

  const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const result = await submitComposer({
      mode,
      payload: {
        categorySlug,
        title: title.trim(),
        topicId,
        bodyMd: bodyMd.trim(),
        parentPostId: replyTo?.postId,
      },
    });

    if (result.ok) {
      if (mode === 'topic' && result.slug) {
        window.location.href = `/t/${result.slug}`;
      } else {
        window.location.reload();
      }
    } else {
      setError(result.error ?? 'Something went wrong.');
      setSubmitting(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      {replyTo && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.8125rem',
            color: 'var(--muted)',
            border: '1px solid var(--border)',
            borderRadius: '0.375rem',
            padding: '0.375rem 0.625rem',
            alignSelf: 'flex-start',
          }}
        >
          <span>
            Replying to <strong style={{ color: 'var(--fg)' }}>{replyTo.author || 'post'}</strong>
          </span>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            aria-label="Cancel reply"
            title="Cancel reply, post as a new comment instead"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
              lineHeight: 1,
            }}
          >
            &#10005;
          </button>
        </div>
      )}
      {mode === 'topic' && (
        <div>
          <label
            htmlFor="composer-title"
            style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem', color: 'var(--muted)' }}
          >
            Title
          </label>
          <input
            id="composer-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Topic title"
            maxLength={200}
            required
            disabled={submitting}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              border: '1px solid var(--border)',
              borderRadius: '0.375rem',
              background: 'var(--bg)',
              color: 'var(--fg)',
              fontSize: '1rem',
            }}
          />
        </div>
      )}

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
          <label
            htmlFor="composer-body"
            style={{ fontSize: '0.875rem', color: 'var(--muted)' }}
          >
            {mode === 'topic' ? 'Body' : 'Reply'}
          </label>
          <button
            type="button"
            onClick={() => setShowPreview((p) => !p)}
            style={{
              fontSize: '0.8125rem',
              color: 'var(--accent)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {showPreview ? 'Edit' : 'Preview'}
          </button>
        </div>

        {showPreview ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: previewHtml is server-sanitized markdown (renderMarkdown in src/lib/markdown.ts, via /api/preview)
          <div dangerouslySetInnerHTML={{ __html: previewHtml || '<p style="color:var(--muted)">Nothing to preview yet.</p>' }}
            className="prose"
            style={{
              minHeight: '7rem',
              padding: '0.5rem 0.75rem',
              border: '1px solid var(--border)',
              borderRadius: '0.375rem',
              fontSize: '0.9375rem',
              lineHeight: '1.6',
              overflowWrap: 'break-word',
            }}
          />
        ) : (
          <>
            <div
              role="toolbar"
              aria-label="Markdown formatting"
              style={{
                display: 'flex',
                gap: '0.25rem',
                marginBottom: '0.375rem',
                flexWrap: 'wrap',
              }}
            >
              {TOOLBAR.map(({ action, label, title }) => (
                <button
                  key={action}
                  type="button"
                  title={title}
                  aria-label={title}
                  disabled={submitting}
                  // Keep textarea focus/selection: prevent the button stealing it on mousedown.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runAction(action)}
                  style={{
                    minWidth: '2rem',
                    height: '2rem',
                    padding: '0 0.5rem',
                    border: '1px solid var(--border)',
                    borderRadius: '0.375rem',
                    background: 'var(--bg)',
                    color: 'var(--fg)',
                    fontSize: '0.875rem',
                    fontWeight: action === 'bold' ? 700 : 500,
                    fontStyle: action === 'italic' ? 'italic' : 'normal',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    lineHeight: 1,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              id="composer-body"
              value={bodyMd}
              onChange={(e) => setBodyMd(e.target.value)}
            placeholder="Write your message in Markdown..."
            maxLength={20000}
            required
            disabled={submitting}
            rows={7}
            style={{
              width: '100%',
              padding: '0.5rem 0.75rem',
              border: '1px solid var(--border)',
              borderRadius: '0.375rem',
              background: 'var(--bg)',
              color: 'var(--fg)',
              fontSize: '0.9375rem',
              lineHeight: '1.6',
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
          </>
        )}
      </div>

      <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>
        Use the toolbar or type Markdown directly: headings, bold, italics, links, quotes, lists, and code.
      </p>

      {error && (
        <div className="callout callout--error" role="alert">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div className="callout__body">{error}</div>
        </div>
      )}

      <div>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '0.5rem 1.25rem',
            background: submitting ? 'var(--muted)' : 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: '0.375rem',
            fontSize: '0.9375rem',
            cursor: submitting ? 'not-allowed' : 'pointer',
            fontWeight: 500,
          }}
        >
          {submitting ? 'Submitting...' : mode === 'topic' ? 'Post topic' : 'Post reply'}
        </button>
      </div>
    </form>
  );
}
