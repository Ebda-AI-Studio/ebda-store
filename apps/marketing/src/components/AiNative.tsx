import { THEMES, THEME_COPY } from '../lib/capabilities';
import type { Locale } from '../lib/site';
import { CapabilityGrid } from './Capabilities';

/** The AI theme: every capability tagged `ai`, once, in the same card layout as every other theme. */
export function AiNative({ locale }: { locale: Locale }) {
  const theme = THEMES.find(t => t.id === 'ai')!;
  return (
    <>
      <p className="lead">{THEME_COPY[locale].ai.lead}</p>
      <CapabilityGrid locale={locale} ids={theme.ids} />
    </>
  );
}
