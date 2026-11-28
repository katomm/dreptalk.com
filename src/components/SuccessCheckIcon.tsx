// The check-circle icon of a success callout (vote or delegation submitted).
// It draws itself in once when it mounts, circle first, then the check
// (.draw-check in global.css, skipped under reduced motion). pathLength="1"
// lets one dash length fit both strokes.
export function SuccessCheckIcon() {
  return (
    <svg
      className="callout__icon draw-check"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" pathLength={1} />
      <polyline points="22 4 12 14.01 9 11.01" pathLength={1} />
    </svg>
  );
}
