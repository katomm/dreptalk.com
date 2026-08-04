// Progressive enhancement for the profile activity tabs: fetch the target tab
// and swap the #activity section in place, so switching never reloads or moves
// the page. Without JS the links still work (server renders the target tab and
// the #activity anchor brings the section back into view). Delegated listener,
// so it survives the section being replaced.
(() => {
  if (!document.getElementById('activity')) return;
  let controller = null;

  function swapFrom(html) {
    const next = new DOMParser().parseFromString(html, 'text/html').getElementById('activity');
    const current = document.getElementById('activity');
    if (!next || !current) return false;
    current.replaceWith(next);
    return true;
  }

  function load(url, push) {
    if (controller) controller.abort();
    controller = new AbortController();
    const busy = document.getElementById('activity');
    if (busy) busy.setAttribute('aria-busy', 'true');
    fetch(url, { signal: controller.signal, headers: { accept: 'text/html' } })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.text();
      })
      .then((html) => {
        if (!swapFrom(html)) throw new Error('missing section');
        if (push) history.pushState({ drepActivityTab: true }, '', url);
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        // Anything unexpected: fall back to the plain server-rendered navigation.
        location.href = url;
      })
      .finally(() => {
        const t = document.getElementById('activity');
        if (t) t.removeAttribute('aria-busy');
      });
  }

  document.addEventListener('click', (ev) => {
    const link = ev.target?.closest?.('.ptabs a[href]') ?? null;
    if (!link) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
    ev.preventDefault();
    // Drop the no-JS #activity anchor: with an in-place swap nothing may scroll,
    // and the address stays clean.
    const url = new URL(link.href);
    url.hash = '';
    load(url.pathname + url.search, true);
  });

  window.addEventListener('popstate', () => {
    load(location.pathname + location.search, false);
  });
})();
