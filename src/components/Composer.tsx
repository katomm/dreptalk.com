import { useState, useEffect, useRef, useCallback } from 'react';
import { submitComposer } from '@/lib/forum/composer.js';

interface ComposerProps {
  mode: 'topic' | 'post';
  categorySlug?: string;
  topicId?: string;
}

export default function Composer({ mode, categorySlug, topicId }: ComposerProps) {
  const [title, setTitle] = useState('');
  const [bodyMd, setBodyMd] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
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
          <div
            className="prose"
            dangerouslySetInnerHTML={{ __html: previewHtml || '<p style="color:var(--muted)">Nothing to preview yet.</p>' }}
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
          <textarea
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
        )}
      </div>

      <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--muted)' }}>
        Markdown is supported. Links, bold, italics, lists, and code blocks are allowed.
      </p>

      {error && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '0.625rem 0.875rem',
            border: '1px solid #f87171',
            borderRadius: '0.375rem',
            color: '#dc2626',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </p>
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
