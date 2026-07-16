// Identicon seam over @stricahq/cardano-identicon. Seed rule: for a DRep pass the
// raw credential hex (dreps.hex); for a pool pass the pool hash with kind="pool";
// for any other author pass its id (a stake address decodes natively).
//
// A bare 28-byte credential hash carries no bech32 prefix for the library to read
// the centre glyph off, so we default a hex seed to a DRep (the pool surfaces pass
// kind="pool" explicitly); bech32 seeds (stake/addr/drep/pool) are auto-detected.
import { identicon, identiconDataUri as striIdenticonDataUri, type IdenticonType } from '@stricahq/cardano-identicon';

export type IdenticonKind = IdenticonType;

const HEX_CRED = /^[0-9a-f]{56}$/i;
const resolveType = (seed: string, kind?: IdenticonKind): IdenticonType | undefined =>
  kind ?? (HEX_CRED.test(seed) ? 'drep' : undefined);

/**
 * Inline, theme-aware identicon markup: a light and a dark SVG, toggled by the
 * global `.idi-l/.idi-d` rule on `html[data-theme]`. Both palettes live in plain
 * attributes (no inline <style>), so this is CSP-safe and follows DRepTalk's
 * manual theme toggle, which the library's own prefers-color-scheme `auto` theme
 * cannot. Used via set:html by Avatar, AuthorIdentity, and the proposer icon.
 */
export function identiconSvg(seed: string, size = 28, kind?: IdenticonKind): string {
  const type = resolveType(seed, kind);
  const light = identicon(seed, { size, type, theme: 'light' }).replace('<svg', '<svg class="idi idi-l"');
  const dark = identicon(seed, { size, type, theme: 'dark' }).replace('<svg', '<svg class="idi idi-d"');
  return light + dark;
}

/**
 * Single-SVG data URI for <img>/OG contexts where a two-SVG toggle cannot live.
 * The `auto` theme follows the viewer's OS scheme in a browser (isolated inside
 * the image, so its inline <style> is CSP-exempt) and renders the light palette
 * in the satori OG rasterizer.
 */
export function identiconDataUri(seed: string, size = 160, kind?: IdenticonKind): string {
  const type = resolveType(seed, kind);
  return striIdenticonDataUri(seed, { size, type, theme: 'auto' });
}
