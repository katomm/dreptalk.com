// Restores the reader's governance-list sort preference from localStorage.
// Sorting is server-driven (it lives in the ?sort= query param), so this script:
//   - mirrors a present param into localStorage (the reader just chose it), and
//   - on an unparameterized visit, redirects to the saved non-default choice
//     before the default view paints.
// Inlined into the governance category page via set:html and pinned in the CSP by
// its SHA-256 hash (see astro.config.mjs). The default is 'new', so only a saved
// non-default triggers a single, loop-safe redirect (the redirected URL then
// carries the param, so the next run just mirrors it).
(() => {
  try {
    const url = new URL(location.href);

    const SORT_KEY = 'dreptalk:gov-sort';
    const SORTS = ['new', 'trending', 'closing', 'ratified'];
    const sortParam = url.searchParams.get('sort');
    if (sortParam) {
      if (SORTS.indexOf(sortParam) !== -1) localStorage.setItem(SORT_KEY, sortParam);
    } else {
      const savedSort = localStorage.getItem(SORT_KEY);
      if (savedSort && savedSort !== 'new' && SORTS.indexOf(savedSort) !== -1) {
        url.searchParams.set('sort', savedSort);
        location.replace(url.toString());
      }
    }
  } catch {}
})();
