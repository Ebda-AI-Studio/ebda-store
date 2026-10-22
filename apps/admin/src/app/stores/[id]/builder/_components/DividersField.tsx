'use client';

/**
 * A section's `dividers` setting in the visual editor: the form page builder's
 * `SectionDividersBlock` over the document. Dividers live on the section as `dividers` (five slots
 * sharing one style); the legacy `showKickerLines` / `showSubtitleLines` flags are still read as the
 * fallback, exactly as the storefront does. A section with no heading offers only the slots that render.
 */
import type { SectionDividers, StoreTheme } from '@ebda/shared';
import {
  SectionDividersBlock,
  type DividerSlot,
} from '../../../../../components/section-design/SectionDividersBlock';

/** Sections without a SectionHeading: the kicker, title and subtitle slots would do nothing. */
const HEADING_LESS = new Set([
  'announcement',
  'header',
  'footer',
  'brand-story',
  'trust-strip',
  'blog-carousel',
]);

export const dividerSlotsFor = (sectionType: string): DividerSlot[] | undefined =>
  HEADING_LESS.has(sectionType) ? ['above', 'belowHeading'] : undefined;

export function DividersField({
  sectionType,
  settings,
  theme,
  onChange,
}: {
  sectionType: string;
  /** The section's settings (dividers and the two legacy line flags are read from it). */
  settings: Record<string, unknown>;
  theme: StoreTheme | undefined;
  onChange: (next: SectionDividers | undefined) => void;
}) {
  return (
    <div data-testid="dividers-field" data-setting-id="builder.dividers">
      <SectionDividersBlock
        values={{
          dividers: settings.dividers as SectionDividers | undefined,
          showKickerLines: settings.showKickerLines as boolean | undefined,
          showSubtitleLines: settings.showSubtitleLines as boolean | undefined,
        }}
        availableSlots={dividerSlotsFor(sectionType)}
        theme={theme}
        onPatch={patch => onChange(patch.dividers)}
      />
    </div>
  );
}
