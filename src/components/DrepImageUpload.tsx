// Shared image picker for DRep profile flows (registration and settings).
// Uploads immediately on selection to /api/drep/image (content-addressed R2)
// and hands the hosted { url, sha256 } to the parent, which embeds it in the
// CIP-119 document. The server validates magic bytes; the checks here only
// keep obvious mistakes out of a network round trip.
import { useRef, useState } from 'react';

export interface HostedImage {
  url: string;
  sha256?: string;
}

interface DrepImageUploadProps {
  value: HostedImage | null;
  onChange: (image: HostedImage | null) => void;
  disabled?: boolean;
}

const MAX_BYTES = 256 * 1024;

export default function DrepImageUpload({ value, onChange, disabled }: DrepImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setError('Only JPG and PNG images are supported.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Image is too large (max 256 KB).');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/drep/image', { method: 'POST', body: file });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Upload failed. Please try again.');
        return;
      }
      onChange((await res.json()) as HostedImage);
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled || busy) return;
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop zone augments the accessible file-picker button below; keyboard users still use that button.
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled && !busy) setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Ignore leave events fired when crossing onto a child element.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.5rem',
        margin: '-0.5rem',
        borderRadius: '0.5rem',
        outline: `2px dashed ${dragOver ? 'var(--accent)' : 'transparent'}`,
        outlineOffset: '2px',
        background: dragOver ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
        transition: 'background 0.12s, outline-color 0.12s',
      }}
    >
      {value ? (
        <img
          src={value.url}
          alt="Profile preview"
          width={56}
          height={56}
          style={{ borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--border)' }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{ width: 56, height: 56, borderRadius: '50%', border: '1px dashed var(--border)', flexShrink: 0 }}
        />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
            style={{
              padding: '0.375rem 0.75rem',
              background: 'transparent',
              color: 'var(--accent)',
              border: '1px solid var(--accent)',
              borderRadius: '0.375rem',
              fontSize: '0.875rem',
              cursor: disabled || busy ? 'not-allowed' : 'pointer',
              opacity: disabled || busy ? 0.7 : 1,
            }}
          >
            {busy ? 'Uploading...' : value ? 'Change image' : 'Upload image'}
          </button>
          {value && (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => onChange(null)}
              style={{
                padding: '0.375rem 0.25rem',
                background: 'none',
                color: 'var(--muted)',
                border: 'none',
                fontSize: '0.875rem',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Remove
            </button>
          )}
        </div>
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>JPG or PNG, max 256 KB. Or drop one here.</span>
        {error && (
          <span role="alert" style={{ fontSize: '0.8125rem', color: 'var(--danger)' }}>
            {error}
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
