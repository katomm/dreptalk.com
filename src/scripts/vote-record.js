// Client-side filter + progressive reveal for the DRep voting-record list.
// Progressive enhancement: without JS every row is visible in the server's
// order (newest first) and the "Show more" button stays hidden. Inlined via
// set:html and pinned in the CSP by its SHA-256 hash (see astro.config.mjs).
// Reads only the data-* attributes the page renders; chip counts are server-set.
(() => {
  const INITIAL = 20;
  const STEP = 20;

  function init() {
    const controls = document.querySelector('[data-record-controls]');
    const list = document.querySelector('[data-record-list]');
    if (!controls || !list) return;

    const rows = Array.from(list.querySelectorAll('[data-record-row]'));
    const chips = Array.from(controls.querySelectorAll('[data-record-filter]'));
    const moreBtn = document.querySelector('[data-record-more]');
    const empty = document.querySelector('[data-record-empty]');

    let filter = 'all';
    let shown = INITIAL;

    const matches = (row) => filter === 'all' || row.getAttribute('data-vote') === filter;

    function render() {
      let seen = 0;
      for (const r of rows) {
        if (!matches(r)) {
          r.hidden = true;
          continue;
        }
        seen++;
        r.hidden = seen > shown;
      }
      // "Show more" appears only while matched rows remain hidden by the cap.
      if (moreBtn) moreBtn.hidden = seen <= shown;
      if (empty) empty.hidden = seen !== 0;
    }

    function reflect() {
      for (const c of chips) {
        const on = c.getAttribute('data-record-filter') === filter;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        filter = chip.getAttribute('data-record-filter');
        shown = INITIAL; // a fresh filter starts from the top, not mid-scroll.
        reflect();
        render();
      });
    });

    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        shown += STEP;
        render();
      });
    }

    reflect();
    render();
  }

  init();
})();
