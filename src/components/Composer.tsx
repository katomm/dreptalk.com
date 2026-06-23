import { useState, useEffect, useRef } from 'react';
import { submitComposer, submitEdit } from '@/lib/forum/composer.js';
import { REPLY_EVENT, type ReplyEventDetail } from '@/lib/forum/replyEvent.js';
import { EDIT_EVENT, type EditEventDetail } from '@/lib/forum/editEvent.js';
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
        window.location.href = `/t/${result.slug}`;
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
    <form ref={formRef} onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
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
          {submitting ? 'Submitting...' : editingPostId ? 'Save edit' : mode === 'topic' ? 'Post topic' : 'Post reply'}
        </button>
      </div>
    </form>
  );
}
