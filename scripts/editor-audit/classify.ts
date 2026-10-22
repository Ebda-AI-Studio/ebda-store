/**
 * Row classification for the editor control matrix (pure; no I/O).
 *
 * Two independent evidence sources must agree before a control is `wired`:
 *   - static: a renderer the template's skin reaches reads the control's key;
 *   - flip probe: rendering the section with each option value changes the HTML.
 * A control whose effect cannot be rendered in isolation (theme and chrome
 * controls) is `static`-only evidence (`probeable: false`); the status is the
 * same, the evidence column says so.
 *
 * Statuses:
 *   wired            both sources agree (or the static source for a non-probeable control)
 *   no-op            shown in the editor, but nothing on this skin reads it or flipping it changes nothing
 *   missing          the look's real variant has no editable control
 *   pending-template the look's skin is not built yet (reported, never failed)
 *   marker-pending   a merchant text or image on a built skin with no explicit canvas marker (Task 2 and 3 markers)
 *   classic-only     the form page builder writes it and the visual editor has no control (Tasks 5 to 8)
 *   exempt           accepted in baseline.json with a reason
 */
export type RowStatus =
  | 'wired'
  | 'no-op'
  | 'missing'
  | 'pending-template'
  | 'marker-pending'
  | 'classic-only'
  | 'exempt';

export interface ClassifyInput {
  /** The control is shown in the editor for this look. */
  shown?: boolean;
  staticHit?: boolean;
  /** Does the control's value change the rendered HTML? */
  probeDiffers?: boolean;
  /** False for controls the probe cannot render in isolation (theme, chrome). Default true. */
  probeable?: boolean;
  /** The look's mix names a variant of this control. */
  inMix?: boolean;
  hasControl?: boolean;
  lookStatus?: 'built' | 'designed';
  skinExists?: boolean;
  /** A merchant text or image the canvas cannot target with an explicit marker. */
  markerMissing?: boolean;
  /** The classic page builder writes it and the visual editor has no control. */
  classicOnly?: boolean;
}

export function classify(i: ClassifyInput): RowStatus {
  if (i.lookStatus !== undefined && i.lookStatus !== 'built' && i.skinExists === false)
    return 'pending-template';
  if (i.classicOnly) return 'classic-only';
  if (i.inMix && i.hasControl === false) return 'missing';
  if (i.markerMissing) return 'marker-pending';
  if (i.shown === false) return 'no-op';
  const probeable = i.probeable !== false;
  if (probeable) return i.staticHit && i.probeDiffers ? 'wired' : 'no-op';
  return i.staticHit ? 'wired' : 'no-op';
}
