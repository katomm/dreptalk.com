// Click-to-copy for the brand page: color swatches and backlink badge
// snippets. Loaded as an external file (never inline) so it satisfies the
// strict CSP (script-src 'self'). One delegated listener handles every copy
// button; scoped to the two brand-page selectors so other data-copy buttons
// on the page (e.g. the header account menu) are not captured here.
(function () {
  function flash(button) {
    // Swatches label with their hex (data-hex), badge buttons with a fixed
    // label (data-copy-label); both restore the original text after a beat.
    var label = button.querySelector('[data-hex], [data-copy-label]');
    if (!label) return;
    var original = label.getAttribute('data-hex') || label.getAttribute('data-copy-label');
    label.textContent = 'Copied';
    button.classList.add('is-copied');
    setTimeout(function () {
      label.textContent = original;
      button.classList.remove('is-copied');
    }, 1200);
  }

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest
      ? event.target.closest('.swatch[data-copy], .embed__copy[data-copy]')
      : null;
    if (!button) return;
    var value = button.getAttribute('data-copy');
    if (!value || !navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(value).then(function () {
      flash(button);
    }).catch(function () {});
  });
})();
