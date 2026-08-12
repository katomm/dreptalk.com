// src/lib/forum/postHistory.ts
// Progressive-enhancement edit-history modal. The "(edited)" marker is a real
// link to /posts/<id>/history (zero-JS fallback); when JS is present this opens
// an inline <dialog> that pages through the changes (Newer/Older buttons or the
// arrow keys), showing a line diff of the markdown source for each. No
// framework: one <dialog> built on demand and removed on close.
//
// XSS invariant: the modal is assembled with innerHTML, so every value
// interpolated into that template MUST be either a safe constant, a formatted
// date (fmt), or HTML-escaped user text (esc, applied to every diff line). The
// raw user markdown (bodyMd) and the stored bodyHtml are NEVER injected into the
// modal unescaped: we only ever show the ESCAPED diff of bodyMd. If you add a
// field here, escape it. (The full rendered bodyHtml is shown only on the SSR
// history page via set:html, the codebase's established sanitized-HTML path.)

import { lineDiff, type DiffOp } from './lineDiff.js';

interface Version {
  bodyMd: string;
  bodyHtml: string;
  createdAt: number;
  current: boolean;
}

function fmt(createdAt: number): string {
  // Locale-aware absolute time; the thread already shows relative time elsewhere.
  return new Date(createdAt).toLocaleString();
}

function renderDiff(ops: DiffOp[]): string {
  // Escapes text; colors add/del. Returned as an HTML string for the diff pane.
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = ops.map((op) => {
    const sign = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
    const color =
      op.type === 'add'
        ? 'background:color-mix(in srgb, #16a34a 16%, transparent);'
        : op.type === 'del'
          ? 'background:color-mix(in srgb, #dc2626 16%, transparent);'
          : '';
    return `<div style="white-space:pre-wrap;${color}"><span style="opacity:0.5">${sign} </span>${esc(op.line) || '&nbsp;'}</div>`;
  });
  return rows.join('');
}

/** Fetches a post's history and opens the diff modal. Errors are swallowed (the link still works). */
export async function openHistoryModal(postId: string): Promise<void> {
  let versions: Version[];
  try {
    const res = await fetch(`/api/posts/${postId}/history`);
    if (!res.ok) return;
    const data = (await res.json()) as { ok: boolean; versions: Version[] };
    if (!data.ok || data.versions.length < 2) return; // nothing to diff
    versions = data.versions;
  } catch {
    return;
  }

  const dialog = document.createElement('dialog');
  dialog.style.cssText =
    'max-width:min(48rem,92vw);width:100%;border:1px solid var(--border);border-radius:0.5rem;background:var(--surface);color:var(--fg);padding:0;';

  // versions[0] is the current body; each later entry is an older revision. A
  // "change" is the diff from one version to the next-older one, so there are
  // versions.length - 1 changes. Open on the most recent change (index 0) and let
  // the reader page through with Newer/Older or the arrow keys.
  const changeCount = versions.length - 1;
  let current = 0;

  const navButton = (label: string, attr: string, disabled: boolean): string =>
    `<button type="button" ${attr} ${disabled ? 'disabled' : ''} style="background:none;border:1px solid var(--border);border-radius:0.375rem;padding:0.25rem 0.625rem;font:inherit;font-size:0.8125rem;color:${disabled ? 'var(--muted)' : 'var(--fg)'};opacity:${disabled ? '0.5' : '1'};cursor:${disabled ? 'default' : 'pointer'};">${label}</button>`;

  const render = (): void => {
    const newer = versions[current];
    const older = versions[current + 1];
    const diffHtml = renderDiff(lineDiff(older.bodyMd, newer.bodyMd));
    dialog.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:1rem 1.25rem;border-bottom:1px solid var(--border);">
        <strong style="font-size:0.95rem;">Edit history</strong>
        <button type="button" data-close aria-label="Close" style="background:none;border:none;color:var(--muted);font-size:1.25rem;cursor:pointer;line-height:1;">&#10005;</button>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;padding:0.75rem 1.25rem;border-bottom:1px solid var(--border);">
        ${navButton('&larr; Newer', 'data-prev', current === 0)}
        <span style="font-size:0.8125rem;color:var(--muted);text-align:center;">Change ${current + 1} of ${changeCount} &middot; ${fmt(newer.createdAt)}${newer.current ? ' (current)' : ''}</span>
        ${navButton('Older &rarr;', 'data-next', current === changeCount - 1)}
      </div>
      <div style="padding:1rem 1.25rem;">
        <div style="font-family:ui-monospace,monospace;font-size:0.8125rem;line-height:1.5;border:1px solid var(--border);border-radius:0.375rem;padding:0.75rem;overflow:auto;max-height:60vh;">
          ${diffHtml || '<em style="color:var(--muted)">No earlier version.</em>'}
        </div>
      </div>`;
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-prev]')?.addEventListener('click', () => go(current - 1));
    dialog.querySelector('[data-next]')?.addEventListener('click', () => go(current + 1));
  };

  const go = (next: number): void => {
    const clamped = Math.max(0, Math.min(changeCount - 1, next));
    if (clamped !== current) {
      current = clamped;
      render();
    }
  };

  // Arrow keys page through changes. Attached once: render() only swaps innerHTML.
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(current - 1);
    else if (e.key === 'ArrowRight') go(current + 1);
  });

  render();
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
