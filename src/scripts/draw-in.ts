// Marks each .draw-in chart as drawn the first time it scrolls into view, which
// starts its one-off animation (global.css). Only runs when theme-init.js set
// html.draw-ready, otherwise the charts are never hidden in the first place.
// Imported by the chart components themselves, so only pages with a chart load
// it. It scans once at load: every chart is server-rendered today. A chart that
// a client island renders later would need its own initDrawIn call.
export function initDrawIn(): void {
  if (!document.documentElement.classList.contains('draw-ready')) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-drawn');
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.4 },
  );
  for (const el of document.querySelectorAll('.draw-in:not(.is-drawn)')) io.observe(el);
}

initDrawIn();
