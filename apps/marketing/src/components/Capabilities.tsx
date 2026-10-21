import Link from 'next/link';
import {
  CAPABILITIES,
  FEATURES_PAGE,
  HOME_CAPABILITIES,
  type CapabilityId,
} from '../lib/capabilities';
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
  ids: readonly CapabilityId[];
  headingLevel?: 2 | 3;
}) {
  const label = FEATURES_PAGE[locale].planLabel;
  const H = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <ul className="cap-grid">
      {ids.map(id => {
        const cap = CAPABILITIES[locale][id];
        return (
          <li key={id} className="cap-card" data-capability={id}>
            <H>{cap.t}</H>
            <p>{withHost(cap.d)}</p>
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
      <CapabilityGrid locale={locale} ids={HOME_CAPABILITIES} />
      <p className="cap-more">
        <Link href={pagePath(locale, 'features')} className="btn btn-ghost">
          {p.homeAll}
        </Link>
      </p>
    </>
  );
}
