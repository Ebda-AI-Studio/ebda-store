/**
 * The ONE size scale of the canvas overlay (editor premium F48): the selected outline, the hover
 * outline and the name chip. The structure tree in the admin uses the same steps (2px gold ring on
 * the selected row, 1px on hover), so the page and the tree read as one tool.
 */
export const OVERLAY_SCALE = {
  /** Selected target: solid gold ring. */
  outlineSelected: 2,
  /** Hover target: a thinner ring, so hover never competes with the selection. */
  outlineHover: 1,
  /** Name chip height (and the gap chipTopFor reserves above a box). */
  chip: 24,
} as const;
