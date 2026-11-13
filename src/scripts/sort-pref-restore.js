// Remembers a reader's sort choice for a server-sorted list in localStorage.
// Sorting is server-driven (it lives in the ?sort= query param), so this script:
//   - mirrors a present, valid param into localStorage (the reader just chose it), and
//   - on a visit without the param, redirects to the saved non-default choice
//     before the default view paints.
// Shared by server-sorted lists through the SortPrefRestore component. Each
// page configures it through data attributes on the script tag:
//   data-key      localStorage key
//   data-sorts    comma-separated list of valid values
//   data-default  the value the server renders without a param (never redirected to)
// Inlined via set:html and pinned in the CSP by its SHA-256 hash (see
// astro.config.mjs). Only a saved non-default triggers a single, loop-safe
// redirect (the redirected URL then carries the param, so the next run just
// mirrors it). An invalid or empty param counts as present: the server renders
// its default for it and nothing is stored or redirected.
(() => {
  try {
    const cfg = document.currentScript.dataset;
    if (!cfg.key || !cfg.sorts) return;
    const sorts = cfg.sorts.split(',');

    const url = new URL(location.href);
    const sortParam = url.searchParams.get('sort');
    if (sortParam !== null) {
      if (sorts.indexOf(sortParam) !== -1) localStorage.setItem(cfg.key, sortParam);
    } else {
      const saved = localStorage.getItem(cfg.key);
      if (saved && saved !== cfg.default && sorts.indexOf(saved) !== -1) {
        url.searchParams.set('sort', saved);
        location.replace(url.toString());
      }
    }
  } catch {}
})();
