import { AI_NATIVE } from '../lib/ai-native';
import { COMING_LABEL, REGISTRY } from '../lib/capability-registry';
import type { Locale } from '../lib/site';
import { withHost } from './Capabilities';

/** The AI-native story: one block per area, each line a merchant outcome; a coming line says so. */
export function AiNative({ locale }: { locale: Locale }) {
  const c = AI_NATIVE[locale];
  return (
    <>
      <p className="lead">{c.lead}</p>
      <ul className="cap-grid ai-grid">
        {c.blocks.map(b => (
          <li key={b.id} className="cap-card" data-ai={b.id}>
            <h3>{b.t}</h3>
            <ul className="ai-lines">
              {b.lines.map(l => {
                const coming = l.needs ? REGISTRY[l.needs].status === 'coming' : false;
                return (
                  <li key={l.text} data-status={coming ? 'coming' : 'live'}>
                    {coming && <span className="cap-badge">{COMING_LABEL[locale]}</span>}
                    {withHost(l.text)}
                    {l.plan && (
                      <span className="cap-plan">
                        {' '}
                        <span>{c.planLabel}</span> {l.plan}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}
