// Marks each .draw-in chart as drawn the first time it scrolls into view, which
// starts its one-off animation (global.css). Only runs when theme-init.js set
// html.draw-ready, otherwise the charts are never hidden in the first place.
export function initDrawIn(root: Document = document): void {
  if (!root.documentElement.classList.contains('draw-ready')) return;
  const items = root.querySelectorAll<Element>('.draw-in:not(.is-drawn)');
  if (items.length === 0) return;
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
  for (const el of items) io.observe(el);
}
