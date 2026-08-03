// Whether the page runs as an installed app (home-screen / standalone PWA).
// iOS Safari exposes the non-standard navigator.standalone flag; every other
// engine reports it through the display-mode media query. Shared by the
// install-hint and pull-to-refresh scripts in Layout.astro so the detection
// cannot drift between them.
export function isStandaloneApp(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
