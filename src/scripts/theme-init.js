// Inlined into <head> via set:html in Layout.astro so it runs synchronously
// before first paint (no render-blocking network request). Because the app's
// CSP is strict (script-src has no 'unsafe-inline'), the SHA-256 of this exact
// file is computed at build time in astro.config.mjs and added to
// security.csp.scriptDirective.hashes. Editing this file automatically updates
// that hash, so keep it as the single source; do not paste the contents inline.
(() => {
  // Anti-flash init: apply the stored (or system) theme before first paint.
  const root = document.documentElement;
  // Keep <meta name="theme-color"> (browser chrome and the installed app's title
  // bar) in sync with the resolved theme, so it stays correct even when the user
  // forces a theme against the OS scheme via the toggle below.
  const setThemeColor = () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', root.getAttribute('data-theme') === 'dark' ? '#0c0a12' : '#ffffff');
  };
  try {
    const stored = localStorage.getItem('theme');
    if (stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      root.setAttribute('data-theme', 'dark');
    }
  } catch {}
  setThemeColor();

  // Toggle wiring (sun/moon + circular-reveal view transition).
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    const html = document.documentElement;
    const isDark = () => html.getAttribute('data-theme') === 'dark';
    const updateLabel = () => {
      btn?.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
    };
    const toggleTheme = () => {
      const next = isDark() ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      try {
        localStorage.setItem('theme', next);
      } catch {}
      updateLabel();
      setThemeColor();
    };
    btn?.addEventListener('click', () => {
      if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        toggleTheme();
        return;
      }
      const r = btn.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const maxR = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      const t = document.startViewTransition(() => toggleTheme());
      t.ready.then(() => {
        html.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`] },
          { duration: 500, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' },
        );
      });
    });
    updateLabel();
  });
})();
