import { useState } from 'react';

interface Props {
  /** Full value copied to the clipboard. */
  value: string;
  /** Accessible label and tooltip. */
  label?: string;
}

/**
 * Copy-to-clipboard icon button for React islands. Mirrors the Astro
 * CopyButton: same global .copy-btn visuals, swaps the clipboard icon for a
 * check for 1.5s after a copy. Drop it right after any on-chain identifier
 * (DRep id, address, tx hash, ...) so people can copy the full value.
 */
export function CopyButton({ value, label = 'Copy' }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={copied ? 'copy-btn is-copied' : 'copy-btn'}
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            // Clipboard can be blocked (no permission / insecure context); ignore.
          });
      }}
    >
      <svg
        className="copy-btn__copy"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </svg>
      <svg
        className="copy-btn__check"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </button>
  );
}
