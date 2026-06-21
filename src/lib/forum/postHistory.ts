// src/lib/forum/postHistory.ts
// Progressive-enhancement edit-history modal. The "(edited)" marker is a real
// link to /posts/<id>/history (zero-JS fallback); when JS is present this opens
// an inline <dialog> with a version selector and a line diff of the markdown
// source. No framework: one <dialog> built on demand and removed on close.
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
  at: number;
  current: boolean;
}

function fmt(at: number): string {
  // Locale-aware absolute time; the thread already shows relative time elsewhere.
  return new Date(at).toLocaleString();
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

  // versions[0] is current (newest). A "change" is the diff from the next-older
  // version to the selected one. Default selection: the most recent change (0).
  const renderFor = (idx: number): string => {
    const newer = versions[idx];
    const older = versions[idx + 1];
    const diffHtml = older ? renderDiff(lineDiff(older.bodyMd, newer.bodyMd)) : '';
    const options = versions
      .slice(0, versions.length - 1) // every version that HAS an older predecessor
      .map(
        (v, i) =>
          `<option value="${i}" ${i === idx ? 'selected' : ''}>${v.current ? 'Current' : 'Revision'} (${fmt(v.at)})</option>`,
      )
      .join('');
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:1rem 1.25rem;border-bottom:1px solid var(--border);">
        <strong style="font-size:0.95rem;">Edit history</strong>
        <button type="button" data-close style="background:none;border:none;color:var(--muted);font-size:1.25rem;cursor:pointer;line-height:1;">&#10005;</button>
      </div>
      <div style="padding:1rem 1.25rem;display:flex;flex-direction:column;gap:0.75rem;">
        <label style="font-size:0.8125rem;color:var(--muted);">
          Change:
          <select data-version style="margin-left:0.5rem;font:inherit;">${options}</select>
        </label>
        <div style="font-family:ui-monospace,monospace;font-size:0.8125rem;line-height:1.5;border:1px solid var(--border);border-radius:0.375rem;padding:0.75rem;overflow:auto;max-height:60vh;">
          ${diffHtml || '<em style="color:var(--muted)">No earlier version.</em>'}
        </div>
      </div>`;
  };

  const mount = (idx: number) => {
    dialog.innerHTML = renderFor(idx);
    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-version]')?.addEventListener('change', (e) => {
      mount(Number((e.target as HTMLSelectElement).value));
    });
  };

  mount(0);
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
