// Restores the reader's governance-list preferences (sort + metric) from
// localStorage. Sorting and the metric column are server-driven (they live in the
// ?sort= and ?metric= query params), so this script:
//   - mirrors a present param into localStorage (the reader just chose it), and
//   - on an unparameterized visit, redirects to the saved non-default choice
//     before the default view paints.
// Inlined into the governance category page via set:html and pinned in the CSP by
// its SHA-256 hash (see astro.config.mjs). Defaults are 'new' and 'sentiment', so
// only a saved non-default triggers a single, loop-safe redirect (the redirected URL
// then carries the param, so the next run just mirrors it).
(function () {
  try {
    var url = new URL(location.href);
    var redirect = false;

    var SORT_KEY = 'dreptalk:gov-sort';
    var SORTS = ['new', 'trending', 'closing', 'ratified'];
    var sortParam = url.searchParams.get('sort');
    if (sortParam) {
      if (SORTS.indexOf(sortParam) !== -1) localStorage.setItem(SORT_KEY, sortParam);
    } else {
      var savedSort = localStorage.getItem(SORT_KEY);
      if (savedSort && savedSort !== 'new' && SORTS.indexOf(savedSort) !== -1) {
        url.searchParams.set('sort', savedSort);
        redirect = true;
      }
    }

    var METRIC_KEY = 'dreptalk:gov-metric';
    var METRICS = ['stake', 'sentiment'];
    var metricParam = url.searchParams.get('metric');
    if (metricParam) {
      if (METRICS.indexOf(metricParam) !== -1) localStorage.setItem(METRIC_KEY, metricParam);
    } else {
      var savedMetric = localStorage.getItem(METRIC_KEY);
      if (savedMetric && savedMetric !== 'sentiment' && METRICS.indexOf(savedMetric) !== -1) {
        url.searchParams.set('metric', savedMetric);
        redirect = true;
      }
    }

    if (redirect) location.replace(url.toString());
  } catch (e) {}
})();
