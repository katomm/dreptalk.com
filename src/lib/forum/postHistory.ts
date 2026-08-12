// src/lib/forum/postHistory.ts
// Progressive-enhancement edit-history modal. The "(edited)" marker is a real
// link to /posts/<id>/history (zero-JS fallback); when JS is present this opens
// an inline <dialog> comparing any two versions. Two views: a rich diff of the
// rendered body (default) and a word-highlighted diff of the markdown source.
//
// XSS invariant: the modal is assembled with innerHTML. The only HTML injected is
// richDiff output. Its inputs are body_html values sanitized at write time by
// renderMarkdown, it preserves only the elements and attributes present in that
// input, and the only things it adds are <span> wrappers around changed word runs
// and the fixed diff classes listed in DIFF_CLASSES. Every other value interpolated
// into this template MUST be a safe constant, a formatted date, or HTML-escaped user
// text. The markdown source (bodyMd) is never injected as HTML: the source view
// escapes every word before marking it.
//
// The diff runs over stored body_html, not over enhanceStoredHtml(body_html): the
// display-time pass emits markup outside the parser grammar this safety argument
// rests on. A diffed post can therefore show a chain id as plain text where the live
// post shows it as a link.

import { richDiff } from './htmlDiff.js';
import { clampVersionPair, formatVersionTime, statText, versionLabel } from './historyView.js';
import { lineDiffWithWords } from './lineDiff.js';

interface Version {
  bodyMd: string;
  bodyHtml: string;
  createdAt: number;
  current: boolean;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Escaped markdown source with word-level markers. Never trusts bodyMd as HTML. */
function renderSourceDiff(oldMd: string, newMd: string): string {
  return lineDiffWithWords(oldMd, newMd)
    .map((line) => {
      const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      const cls =
        line.type === 'add' ? ' class="diff-line-add"' : line.type === 'del' ? ' class="diff-line-del"' : '';
      const body = line.parts
        .map((p) => (p.type === 'same' ? esc(p.text) : `<span class="diff-${p.type}">${esc(p.text)}</span>`))
        .join('');
      return `<div${cls}><span style="opacity:0.5">${sign} </span>${body || '&nbsp;'}</div>`;
    })
    .join('');
}

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

  const count = versions.length;
  let pair = clampVersionPair(null, null, count);
  if (!pair) return;
  let view: 'rich' | 'source' = 'rich';

  const dialog = document.createElement('dialog');
  dialog.style.cssText =
    'max-width:min(48rem,92vw);width:100%;border:1px solid var(--border);border-radius:0.5rem;background:var(--surface);color:var(--fg);padding:0;';

  const label = (i: number): string => versionLabel(i, count, versions[i].current);

  // from must stay strictly older than to, so each select disables the other's side.
  const optionsFor = (which: 'from' | 'to', current: { from: number; to: number }): string =>
    versions
      .map((_, i) => {
        const disabled = which === 'from' ? i <= current.to : i >= current.from;
        return `<option value="${i}"${i === (which === 'from' ? current.from : current.to) ? ' selected' : ''}${disabled ? ' disabled' : ''}>${label(i)}</option>`;
      })
      .join('');

  const render = (): void => {
    const { from, to } = pair as { from: number; to: number };
    const diff = richDiff(versions[from].bodyHtml, versions[to].bodyHtml);
    // A body the parser refused. The source view needs no parser, so it still works.
    const showSource = view === 'source' || diff.degraded;
    const notice = diff.degraded
      ? '<p style="color:var(--muted);font-size:0.8125rem;margin:0 0 0.75rem;">A rendered diff is not available for these versions. Showing the markdown source instead.</p>'
      : '';
    const pane = showSource
      ? `${notice}<div class="diff-source">${renderSourceDiff(versions[from].bodyMd, versions[to].bodyMd)}</div>`
      : `<div class="prose">${diff.html}</div>`;
    const stat = diff.degraded ? '' : ` &middot; ${statText(diff.added, diff.removed, diff.changed)}`;

    dialog.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:1rem 1.25rem;border-bottom:1px solid var(--border);">
        <strong style="font-size:0.95rem;">Edit history</strong>
        <button type="button" data-close aria-label="Close" style="background:none;border:none;color:var(--muted);font-size:1.25rem;cursor:pointer;line-height:1;">&#10005;</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:0.75rem;padding:0.75rem 1.25rem;border-bottom:1px solid var(--border);font-size:0.8125rem;">
        <div style="display:flex;align-items:center;gap:0.5rem;">
          <label>Compare <select data-from>${optionsFor('from', pair as { from: number; to: number })}</select></label>
          <label>to <select data-to>${optionsFor('to', pair as { from: number; to: number })}</select></label>
        </div>
        <span style="color:var(--muted);">${esc(formatVersionTime(versions[to].createdAt))}${stat}</span>
        <div>
          <button type="button" data-view="rich" aria-pressed="${!showSource}" ${diff.degraded ? 'disabled' : ''}>Rendered</button>
          <button type="button" data-view="source" aria-pressed="${showSource}">Source</button>
        </div>
      </div>
      <div style="padding:1rem 1.25rem;max-height:60vh;overflow:auto;">${pane}</div>`;

    dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-from]')?.addEventListener('change', (e) => {
      pair = clampVersionPair((e.target as HTMLSelectElement).value, pair?.to, count);
      render();
    });
    dialog.querySelector('[data-to]')?.addEventListener('change', (e) => {
      pair = clampVersionPair(pair?.from, (e.target as HTMLSelectElement).value, count);
      render();
    });
    for (const btn of dialog.querySelectorAll('[data-view]')) {
      btn.addEventListener('click', () => {
        view = btn.getAttribute('data-view') === 'source' ? 'source' : 'rich';
        render();
      });
    }
  };

  // Arrow keys step the compared pair one version older or newer, keeping them adjacent.
  dialog.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'SELECT') return;
    if (!pair) return;
    if (e.key === 'ArrowLeft') {
      pair = clampVersionPair(pair.to, pair.to - 1, count);
      render();
    } else if (e.key === 'ArrowRight') {
      pair = clampVersionPair(pair.from + 1, pair.from, count);
      render();
    }
  });

  render();
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
