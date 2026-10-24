// The header and footer logo wears a Santa hat from December 1 through
// January 6 (Epiphany). Checked per render in UTC, so a cached page can show
// the previous state for up to the page cache's staleness window.
export function isHatSeason(now: Date): boolean {
  const month = now.getUTCMonth();
  return month === 11 || (month === 0 && now.getUTCDate() <= 6);
}

// `?hat=1` forces the hat on and `?hat=0` off, so the look can be checked
// outside the season. Any other value falls back to the calendar.
export function showLogoHat(url: URL, now: Date = new Date()): boolean {
  const param = url.searchParams.get('hat');
  if (param === '1') return true;
  if (param === '0') return false;
  return isHatSeason(now);
}
