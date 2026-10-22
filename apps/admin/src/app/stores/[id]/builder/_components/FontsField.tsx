'use client';

/**
 * The font library in the theme pane: the page builder's own `FontsCard` over the draft. The list is
 * the effective one (live + the pending draft patch); a change replaces the WHOLE library in the draft
 * (`PageDefinition.typography.fonts`), so nothing reaches the live store before Publish (Ruling VE-4).
 * Uploading a font file only stores the file; the font is in no store until the draft is published.
 */
import { FontsCard, type FontEntry } from '../../../../../components/section-design/FontsCard';

export function FontsField({
  storeId,
  fonts,
  onChange,
}: {
  storeId: string;
  fonts: FontEntry[];
  onChange: (next: FontEntry[]) => void;
}) {
  return (
    <div data-testid="fonts-field" data-setting-id="builder.fonts">
      <FontsCard storeId={storeId} fonts={fonts} onChange={onChange} />
    </div>
  );
}
