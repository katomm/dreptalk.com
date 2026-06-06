(function () {
  // Anti-flash init: apply the stored (or system) theme before first paint.
  var root = document.documentElement;
  try {
    var stored = localStorage.getItem('theme');
    if (stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      root.setAttribute('data-theme', 'dark');
    }
  } catch (e) {}

  // Toggle wiring (sun/moon + circular-reveal view transition).
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    var html = document.documentElement;
    var isDark = function () { return html.getAttribute('data-theme') === 'dark'; };
    function updateLabel() {
      if (btn) btn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
    }
    function toggleTheme() {
      var next = isDark() ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
      updateLabel();
    }
    btn && btn.addEventListener('click', function () {
      if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        toggleTheme();
        return;
      }
      var r = btn.getBoundingClientRect();
      var x = r.left + r.width / 2;
      var y = r.top + r.height / 2;
      var maxR = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      var t = document.startViewTransition(function () { toggleTheme(); });
      t.ready.then(function () {
        html.animate(
          { clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + maxR + 'px at ' + x + 'px ' + y + 'px)'] },
          { duration: 500, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' }
        );
      });
    });
    updateLabel();
  });
})();
