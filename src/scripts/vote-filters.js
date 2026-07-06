// Client-side filter + sort for the DRep vote dashboard's open-actions list.
// Progressive enhancement: without JS every row is visible in the server's
// default order (closing soonest). Inlined via set:html and pinned in the CSP by
// its SHA-256 hash (see astro.config.mjs). Reads only the data-* attributes the
// page renders; the "closing soon" highlight is server-set, so it always matches
// the stats strip's count.
(() => {
  function init() {
    const controls = document.querySelector('[data-vote-controls]');
    const list = document.querySelector('[data-vote-list]');
    if (!controls || !list) return;

    const rows = Array.from(list.querySelectorAll('[data-vote-row]'));
    const empty = document.querySelector('[data-vote-empty]');
    const seg = controls.querySelectorAll('[data-status]');
    const typeSel = controls.querySelector('[data-type-filter]');
    const sortSel = controls.querySelector('[data-sort]');

    let status = 'all';
    const num = (v) => (v === '' || v == null ? null : Number(v));

    function matches(row) {
      const voted = row.getAttribute('data-voted') === '1';
      if (status === 'notvoted' && voted) return false;
      if (status === 'voted' && !voted) return false;
      const t = typeSel ? typeSel.value : '';
      if (t && row.getAttribute('data-type') !== t) return false;
      return true;
    }

    function sortRows() {
      const mode = sortSel ? sortSel.value : 'closing';
      const byExpiry = (a, b) =>
        (num(a.getAttribute('data-expiry')) ?? Infinity) - (num(b.getAttribute('data-expiry')) ?? Infinity);
      const cmps = {
        closing: byExpiry,
        recent: (a, b) => {
          const at = (num(a.getAttribute('data-submitted-at')) ?? -Infinity);
          const bt = (num(b.getAttribute('data-submitted-at')) ?? -Infinity);
          if (bt !== at) return bt - at;
          const ae = (num(a.getAttribute('data-submitted-epoch')) ?? -Infinity);
          const be = (num(b.getAttribute('data-submitted-epoch')) ?? -Infinity);
          return be - ae;
        },
        type: (a, b) =>
          a.getAttribute('data-type').localeCompare(b.getAttribute('data-type')) || byExpiry(a, b),
      };
      const cmp = cmps[mode] || cmps.closing;
      for (const r of rows.slice().sort(cmp)) list.appendChild(r);
    }

    function apply() {
      let visible = 0;
      for (const r of rows) {
        const show = matches(r);
        r.hidden = !show;
        if (show) visible++;
      }
      if (empty) {
        empty.hidden = visible !== 0;
        if (visible === 0) {
          empty.textContent =
            status === 'notvoted'
              ? "You're all caught up, nothing open awaits your vote."
              : status === 'voted'
                ? "You haven't voted on any open actions yet."
                : 'No open actions match these filters.';
        }
      }
    }

    seg.forEach((btn) => {
      btn.addEventListener('click', () => {
        status = btn.getAttribute('data-status');
        seg.forEach((b) => {
          const on = b === btn;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        apply();
      });
    });
    if (typeSel) typeSel.addEventListener('change', apply);
    if (sortSel) sortSel.addEventListener('change', sortRows);

    apply();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
