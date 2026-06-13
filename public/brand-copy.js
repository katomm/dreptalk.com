// Click-to-copy for the brand color swatches. Loaded as an external file (never
// inline) so it satisfies the strict CSP (script-src 'self'). One delegated
// listener handles every swatch button; scoped to .swatch so other data-copy
// buttons on the page (e.g. the header account menu) are not captured here.
(function () {
  function flash(button) {
    var hex = button.querySelector('[data-hex]');
    if (!hex) return;
    var original = hex.getAttribute('data-hex');
    hex.textContent = 'Copied';
    button.classList.add('is-copied');
    setTimeout(function () {
      hex.textContent = original;
      button.classList.remove('is-copied');
    }, 1200);
  }

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('.swatch[data-copy]') : null;
    if (!button) return;
    var value = button.getAttribute('data-copy');
    if (!value || !navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(value).then(function () {
      flash(button);
    }).catch(function () {});
  });
})();
