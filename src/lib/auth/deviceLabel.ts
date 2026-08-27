// Turns a stored device-pairing User-Agent into a short, human-readable label
// such as "Chrome on Android" for the pairing confirmation screen. Pure: no
// DOM, so it unit-tests in the node project.
//
// This is a sanity check for the approver, not a security guarantee: a
// User-Agent string is client-supplied and trivially spoofed. It gives the
// approver something plausible to eyeball before consenting, nothing more.

// Above this length a raw (unparsed) string is truncated so a long or
// unusual User-Agent cannot blow out the confirmation card layout.
const MAX_RAW_LEN = 60;

function detectBrowser(ua: string): string | null {
  // Order matters: several browsers embed "Chrome" or "Safari" tokens in
  // their own User-Agent for compatibility, so the more specific tokens are
  // matched first.
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua) || /Opera/.test(ua)) return 'Opera';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/FxiOS/.test(ua) || /Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS/.test(ua) || /Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  return null;
}

function detectPlatform(ua: string): string | null {
  if (/Windows/.test(ua)) return 'Windows';
  // Checked before the generic "Linux" and "Mac OS X" tokens both platforms
  // also carry.
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPod/.test(ua)) return 'iOS';
  if (/iPad/.test(ua)) return 'iPadOS';
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

/**
 * Describes a device from its User-Agent string, e.g. "Chrome on Android".
 * Falls back to the raw string (truncated) when either the browser or the
 * platform cannot be identified with confidence, rather than guessing.
 * A missing User-Agent (null) reports as "Unknown device".
 */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  const browser = detectBrowser(userAgent);
  const platform = detectPlatform(userAgent);
  if (browser && platform) return `${browser} on ${platform}`;

  return userAgent.length > MAX_RAW_LEN ? `${userAgent.slice(0, MAX_RAW_LEN)}...` : userAgent;
}

/**
 * The same description, shaped for storage on a session: null when the request
 * carried no User-Agent, so the device list can say "Unknown device" itself
 * rather than persisting that phrase as if it were a real label.
 */
export function sessionDeviceLabel(userAgent: string | null | undefined): string | null {
  return userAgent ? describeUserAgent(userAgent) : null;
}
