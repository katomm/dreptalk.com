// Inlined into <head> via set:html in Layout.astro so it runs synchronously
// before first paint (no render-blocking network request). Because the app's
// CSP is strict (script-src has no 'unsafe-inline'), the SHA-256 of this exact
// file is computed at build time in astro.config.mjs and added to
// security.csp.scriptDirective.hashes. Editing this file automatically updates
// that hash, so keep it as the single source and do not paste the contents inline.
(() => {
  const root = document.documentElement;
  const osDark = matchMedia('(prefers-color-scheme: dark)');
  const LABELS = { light: 'Light', dark: 'Dark', system: 'System' };

  // The reader's choice: 'light', 'dark' or 'system'. localStorage holds only
  // the two explicit themes under "theme". No entry (or anything else) means
  // System. The mode is kept in memory as well, so a choice still works for the
  // current page view when storage is blocked.
  const readMode = () => {
    try {
      const stored = localStorage.getItem('theme');
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  };
  let mode = readMode();

  const resolve = (m = mode) => (m === 'system' ? (osDark.matches ? 'dark' : 'light') : m);

  // Applies the resolved theme and keeps <meta name="theme-color"> (browser
  // chrome and the installed app's title bar) in sync with it, so it stays
  // correct when the reader forces a theme against the OS scheme.
  const apply = () => {
    const theme = resolve();
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0c0a12' : '#ffffff');
  };

  // Marks the active entry of the theme menu and names the mode on its button.
  // Tolerates a missing menu: an OS or storage event can arrive before the
  // document is parsed.
  const syncUi = () => {
    for (const item of document.querySelectorAll('[data-theme-choice]')) {
      item.setAttribute('aria-pressed', String(item.getAttribute('data-theme-choice') === mode));
    }
    document.getElementById('theme-toggle')?.setAttribute('aria-label', `Theme: ${LABELS[mode]}`);
  };

  // Anti-flash: apply the stored (or system) theme before first paint.
  apply();

  // System mode follows the OS live. With an explicit theme the resolved value
  // does not depend on the OS, so the same call changes nothing.
  osDark.addEventListener?.('change', apply);

  // Picks up a choice this page view did not make itself.
  const reread = () => {
    mode = readMode();
    apply();
    syncUi();
  };
  // A choice made in another tab of this browser. key is null after clear().
  window.addEventListener('storage', (event) => {
    if (event.key === 'theme' || event.key === null) reread();
  });
  // A page restored from the back/forward cache still holds the state it had
  // when the reader left it, and its own tab sends it no storage event.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) reread();
  });

  const setMode = (next) => {
    mode = next;
    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch {}
    apply();
    syncUi();
  };

  // Menu wiring (three entries + circular-reveal view transition).
  document.addEventListener('DOMContentLoaded', () => {
    syncUi();
    const menu = document.getElementById('theme-menu');
    const btn = document.getElementById('theme-toggle');
    if (!menu || !btn) return;
    for (const item of menu.querySelectorAll('[data-theme-choice]')) {
      item.addEventListener('click', () => {
        const next = item.getAttribute('data-theme-choice');
        // Close first, so the panel is in neither snapshot of the transition.
        menu.open = false;
        btn.focus();
        // The reveal only runs when the visible theme changes. Picking System
        // on an OS that already matches just moves the mark.
        if (
          resolve() === resolve(next) ||
          !document.startViewTransition ||
          matchMedia('(prefers-reduced-motion: reduce)').matches
        ) {
          setMode(next);
          return;
        }
        const r = btn.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const maxR = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        const t = document.startViewTransition(() => setMode(next));
        // `ready` rejects when the browser skips the transition (hidden page, a
        // newer transition). The theme is switched either way, only the reveal
        // is dropped.
        t.ready.then(
          () => {
            root.animate(
              { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`] },
              { duration: 500, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' },
            );
          },
          () => {},
        );
      });
    }
  });
})();
