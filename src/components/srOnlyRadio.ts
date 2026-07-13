import type { CSSProperties } from 'react';

// Visually hidden but focusable radio input: the styled <label> is the visible
// control while the native radio drives selection, keyboard (arrow) navigation,
// and assistive tech. Using `display:none` instead would drop the input from the
// tab order AND the accessibility tree, making the group mouse-only. The enclosing
// label reflects focus with its own outline (the 1x1 input's own outline is not
// visible), so keyboard users still get a focus indicator.
export const srOnlyRadio: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: 0,
  opacity: 0,
  pointerEvents: 'none',
};
