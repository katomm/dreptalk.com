import { useState, useEffect, useRef } from 'react';
import { submitComposer, submitEdit } from '@/lib/forum/composer.js';
import { REPLY_EVENT, type ReplyEventDetail } from '@/lib/forum/replyEvent.js';
import { EDIT_EVENT, type EditEventDetail } from '@/lib/forum/editEvent.js';
import { QUOTE_EVENT, type QuoteEventDetail } from '@/lib/forum/quoteEvent.js';
import { buildQuoteBlock, appendQuote } from '@/lib/forum/quoteFormat.js';
import MarkdownEditor, { type MarkdownEditorHandle } from '@/components/MarkdownEditor.js';

interface ComposerProps {
  mode: 'topic' | 'post';
  categorySlug?: string;
  topicId?: string;
}

export default function Composer({ mode, categorySlug, topicId }: ComposerProps) {
  const [title, setTitle] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reply target set by a post's Reply button (one-level threading).
  const [replyTo, setReplyTo] = useState<ReplyEventDetail | null>(null);
  // Post being edited, set by a post's Edit button. Mutually exclusive with replyTo.
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  // Shown briefly after a quote is appended. Fixed-position so it is visible even
  // when the user is scrolled up at the post they quoted.
  const [quoteToast, setQuoteToast] = useState(false);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // The Reply buttons live in server-rendered markup (no island), so they talk
  // to the composer via a window event. Scroll the form into view and focus the
  // textarea so the click lands the user where they can type.
  useEffect(() => {
    if (mode !== 'post') return;
    const onReply = (e: Event) => {
      const detail = (e as CustomEvent<ReplyEventDetail>).detail;
      if (!detail?.postId) return;
      // Reply and edit are mutually exclusive: starting a reply leaves edit mode.
      setEditingPostId(null);
      setReplyTo(detail);
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      editorRef.current?.focus();
    };
    window.addEventListener(REPLY_EVENT, onReply);
    return () => window.removeEventListener(REPLY_EVENT, onReply);
  }, [mode]);

  // Edit buttons live in server-rendered markup; they hand the post id + current
  // source here via a window event (the source is fetched by the dispatcher).
  useEffect(() => {
    if (mode !== 'post') return;
    const onEdit = (e: Event) => {
      const detail = (e as CustomEvent<EditEventDetail>).detail;
      if (!detail?.postId) return;
      setReplyTo(null);
      setEditingPostId(detail.postId);
      setBodyMd(detail.bodyMd);
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      editorRef.current?.focus();
    };
    window.addEventListener(EDIT_EVENT, onEdit);
    return () => window.removeEventListener(EDIT_EVENT, onEdit);
  }, [mode]);

  // The floating "Quote reply" button lives in server-rendered post markup, it
  // hands the selected passage here via a window event. Quoting never touches
  // replyTo (stacked quotes can come from several posts, so there is no single
  // thread parent) and is refused while editing or submitting.
  useEffect(() => {
    if (mode !== 'post') return;
    const onQuote = (e: Event) => {
      const detail = (e as CustomEvent<QuoteEventDetail>).detail;
      if (!detail?.postId || !detail.text) return;
      if (editingPostId || submitting) return;
      const block = buildQuoteBlock({ author: detail.author, href: detail.href, text: detail.text });
      const result = appendQuote(bodyMd, block, 20000);
      if (!result.ok) {
        setError('That quote would make the reply too long.');
        return;
      }
      setBodyMd(result.value);
      setQuoteToast(true);
    };
    window.addEventListener(QUOTE_EVENT, onQuote);
    return () => window.removeEventListener(QUOTE_EVENT, onQuote);
  }, [mode, editingPostId, submitting, bodyMd]);

  // Auto-dismiss the confirmation.
  useEffect(() => {
    if (!quoteToast) return;
    const t = setTimeout(() => setQuoteToast(false), 4000);
    return () => clearTimeout(t);
  }, [quoteToast]);

  const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    // Edit path: update an existing post, then reload onto it.
    if (editingPostId) {
      const result = await submitEdit({ postId: editingPostId, bodyMd: bodyMd.trim() });
      if (result.ok) {
        sessionStorage.setItem('dreptalk:land-on-post', editingPostId);
        window.location.hash = `post-${editingPostId}`;
        window.location.reload();
      } else {
        setError(result.error ?? 'Something went wrong.');
        setSubmitting(false);
      }
      return;
    }

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
        window.location.href = `/t/${result.slug}/`;
      } else {
        if (result.postId) {
          sessionStorage.setItem('dreptalk:land-on-post', result.postId);
          window.location.hash = `post-${result.postId}`;
        }
        window.location.reload();
      }
    } else {
      setError(result.error ?? 'Something went wrong.');
      setSubmitting(false);
    }
  };

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      data-composer-state={editingPostId ? 'edit' : submitting ? 'submitting' : 'reply'}
      style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}
    >
      {quoteToast && (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: '1.5rem',
            transform: 'translateX(-50%)',
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.5rem 0.875rem',
            borderRadius: '0.5rem',
            background: 'var(--fg)',
            color: 'var(--bg)',
            fontSize: '0.8125rem',
            boxShadow: '0 4px 16px rgba(0,0,0,0.28)',
          }}
        >
          <span>Added to your reply</span>
          <button
            type="button"
            onClick={() => {
              setQuoteToast(false);
              formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              editorRef.current?.focusAtEnd();
            }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--bg)',
              textDecoration: 'underline',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
            }}
          >
            Jump to reply
          </button>
        </div>
      )}
      {editingPostId && (
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
          <span>Editing your post</span>
          <button
            type="button"
            onClick={() => {
              setEditingPostId(null);
              setBodyMd('');
            }}
            aria-label="Cancel edit"
            title="Cancel editing"
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

      <MarkdownEditor
        ref={editorRef}
        value={bodyMd}
        onChange={setBodyMd}
        maxLength={20000}
        label={mode === 'topic' ? 'Body' : 'Reply'}
        idPrefix="composer"
        placeholder="Write your message in Markdown..."
        required
        disabled={submitting}
      />

      {error && (
        <div className="callout callout--error" role="alert">
          <svg className="callout__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div className="callout__body">{error}</div>
        </div>
      )}

      <div>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Submitting...' : editingPostId ? 'Save edit' : mode === 'topic' ? 'Post topic' : 'Post reply'}
        </button>
      </div>
    </form>
  );
}
