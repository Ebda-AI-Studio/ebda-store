import Link from 'next/link';
import { CAPABILITIES, FEATURES_PAGE, HOME_CAPABILITIES, type CardId } from '../lib/capabilities';
import { COMING_LABEL, REGISTRY } from '../lib/capability-registry';
import { pagePath, type Locale } from '../lib/site';

/** Renders the free-address example in a left-to-right isolate so it never reverses inside Arabic text. */
export function withHost(text: string) {
  const parts = text.split(/(yourname\.ebda\.app)/);
  return parts.map((t, i) =>
    t === 'yourname.ebda.app' ? (
      <bdi key={i} dir="ltr">
        {t}
      </bdi>
    ) : (
      t
    )
  );
}

/** One block per real capability: a title, full sentences, and the plans that have it when not all. */
export function CapabilityGrid({
  locale,
  ids,
  headingLevel = 3,
}: {
  locale: Locale;
  ids: readonly CardId[];
  headingLevel?: 2 | 3;
}) {
  const label = FEATURES_PAGE[locale].planLabel;
  const H = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <ul className="cap-grid">
      {ids.map(id => {
        const cap = CAPABILITIES[locale][id];
        const coming = REGISTRY[id].status === 'coming';
        return (
          <li key={id} className="cap-card" data-capability={id} data-status={REGISTRY[id].status}>
            {coming && <span className="cap-badge">{COMING_LABEL[locale]}</span>}
            <H>{cap.t}</H>
            <p>{withHost(cap.d)}</p>
            {cap.soon && (
              <p className="cap-soon" data-status={REGISTRY[cap.soon.needs].status}>
                {REGISTRY[cap.soon.needs].status === 'coming' && (
                  <span className="cap-badge">{COMING_LABEL[locale]}</span>
                )}
                {cap.soon.text}
              </p>
            )}
            {cap.note && <p className="cap-plan">{cap.note}</p>}
            {cap.plan && (
              <p className="cap-plan">
                <span>{label}</span> {cap.plan}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Home section: the capabilities people ask about most, with links to /features and the comparisons. */
export function HomeCapabilities({ locale }: { locale: Locale }) {
  const p = FEATURES_PAGE[locale];
  return (
    <>
      <p className="lead">{p.homeLead}</p>
      <ul className="value-list">
        {HOME_CAPABILITIES.map(id => (
          <li key={id} data-value={id}>
            {CAPABILITIES[locale][id].t}
          </li>
        ))}
      </ul>
      <p className="cap-more">
        <Link href={pagePath(locale, 'features')} className="btn btn-ghost">
          {p.homeAll}
        </Link>
      </p>
    </>
  );
}
