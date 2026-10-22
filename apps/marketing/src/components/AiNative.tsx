import { CAPABILITIES, THEMES, THEME_COPY } from '../lib/capabilities';
import type { Locale } from '../lib/site';

/**
 * The AI theme as a list of rows (where the AI works, and what it does there): every
 * capability tagged `ai`, once. Rows, not cards, so it reads differently from the value list.
 */
export function AiNative({ locale }: { locale: Locale }) {
  const theme = THEMES.find(t => t.id === 'ai')!;
  return (
    <>
      <p className="lead">{THEME_COPY[locale].ai.lead}</p>
      <ul className="ai-flow" role="list">
        {theme.ids.map(id => (
          <li key={id} data-ai-area={id}>
            <h3>{CAPABILITIES[locale][id].t}</h3>
            <p>{CAPABILITIES[locale][id].d}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
