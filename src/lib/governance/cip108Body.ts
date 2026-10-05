// The one rule for turning a CIP-108 document's two body fields into the
// single text that gets rendered.
//
// CIP-108 defines `motivation` and `rationale` as separate fields, and
// proposers routinely split one document across both (motivation = intro and
// early sections, rationale = later sections). They are therefore merged into
// one Markdown text before rendering, in document order, which is what lets a
// reference definition in the rationale resolve a link written in the
// motivation. Rendering them apart would show that link as raw Markdown.
//
// Both the action page's extractor (extractCip108 in metadata.ts) and the
// submit form's review preview go through this function, so the preview cannot
// show a document differently from the page it is a preview of.
//
// Leaf module whose only import is the field caps, so the client island can
// pull it in without dragging the server-only renderer or the canonicalization
// engine into the browser bundle.
import { INFO_MOTIVATION_MAX, INFO_RATIONALE_MAX } from './infoActionLimits.js';

/** What goes between the two fields in the merged body: one blank line. */
export const CIP108_BODY_SEPARATOR = '\n\n';

/**
 * The longest merged body the two fields can produce: both of them full, plus
 * the separator between them. What the preview route caps its `body` part at,
 * so that cap follows the fields instead of restating their arithmetic.
 */
export const CIP108_BODY_MAX = INFO_MOTIVATION_MAX + INFO_RATIONALE_MAX + CIP108_BODY_SEPARATOR.length;

/**
 * The merged body: motivation then rationale, separated by a blank line, with
 * empty fields left out and the occasional document that puts the identical
 * text in both fields reduced to one copy.
 */
export function cip108Body(motivation: string, rationale: string): string {
  const m = motivation.trim();
  const r = rationale.trim();
  if (m && m === r) return r;
  return [m, r].filter(Boolean).join(CIP108_BODY_SEPARATOR);
}
