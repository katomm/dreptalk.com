// Legacy vote deep links (#vote-<id>) predate the profile activity tabs and
// land on the default All tab, where the votes table is not rendered. Hop once
// to the votes tab, keeping the hash so the row anchor still scrolls into view.
// Inlined only on non-votes tabs (see the profile page), CSP-pinned by hash.
(() => {
  if (location.hash.indexOf('#vote-') !== 0) return;
  var u = new URL(location.href);
  if (u.searchParams.get('tab') === 'votes') return;
  u.searchParams.set('tab', 'votes');
  location.replace(u.href);
})();
