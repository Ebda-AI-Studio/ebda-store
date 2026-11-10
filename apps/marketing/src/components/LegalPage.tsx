import { PageLink } from './PageLink';
import { LEGAL_POLICIES, currentLegalVersion, formatLegalDate } from '@ebda/shared/legal';
import { COPY } from '../lib/content';
import { HOME, pagePath, type LegalExtraSlug, type LegalSlug, type Locale } from '../lib/site';
import type { LegalPages } from '../lib/legal-types';
import { pageJsonLd } from '../lib/seo';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { OfficeBlock } from './OfficeBlock';

type StoreDocKey = keyof Pick<
  LegalPages,
  'legal' | 'privacy' | 'terms' | 'merchant' | 'acceptableUse'
>;
type ExtraDocKey = keyof Pick<
  LegalPages,
  'dataDeletion' | 'refund' | 'waTerms' | 'waPrivacy' | 'waDpa'
>;

const DOC_KEY: Record<LegalSlug, StoreDocKey> = {
  legal: 'legal',
  privacy: 'privacy',
  terms: 'terms',
  'merchant-agreement': 'merchant',
  'acceptable-use': 'acceptableUse',
};

/** Documents under /legal/ that are not Ebda Store acceptance documents: they carry their own version and date. */
const EXTRA_KEY: Record<LegalExtraSlug, ExtraDocKey> = {
  'legal/data-deletion': 'dataDeletion',
  'legal/whatsapp-terms': 'waTerms',
  'legal/whatsapp-privacy': 'waPrivacy',
  'legal/whatsapp-dpa': 'waDpa',
  refund: 'refund',
};

export function LegalPage({ locale, page }: { locale: Locale; page: LegalSlug | LegalExtraSlug }) {
  const c = COPY[locale].legalPages;
  const doc =
    page in EXTRA_KEY ? c[EXTRA_KEY[page as LegalExtraSlug]] : c[DOC_KEY[page as LegalSlug]];
  const current = doc.meta ?? currentLegalVersion(LEGAL_POLICIES, DOC_KEY[page as LegalSlug]);
  return (
    <>
      <JsonLd
        data={pageJsonLd(locale, page, doc.title, doc.sections[0].p[0].slice(0, 160), {
          dateModified: current.publishedAt,
          legalEntity: true,
        })}
      />
      <Header locale={locale} page={page} />
      <main id="main" className="wrap legal">
        <header className="legal-head">
          <h1>{doc.title}</h1>
          <p className="legal-meta">
            {c.updated.label}{' '}
            <time dateTime={current.publishedAt}>
              {formatLegalDate(current.publishedAt, locale)}
            </time>{' '}
            · {c.updated.versionLabel} {current.version}
          </p>
          <p className="legal-notice">{c.notice}</p>
          {doc.note && (
            <p className="legal-notice" role="note">
              {doc.note}
            </p>
          )}
        </header>
        <div className="legal-body">
          <nav className="legal-toc" aria-labelledby="toc-h">
            <p id="toc-h" className="legal-toc-h">
              {c.toc}
            </p>
            <ol>
              {doc.sections.map((s, i) => (
                <li key={s.h}>
                  <a href={`#s-${i + 1}`}>{s.h}</a>
                </li>
              ))}
            </ol>
          </nav>
          <article className="legal-doc">
            {doc.sections.map((s, i) => (
              <section key={s.h} id={`s-${i + 1}`} aria-labelledby={`s-${i + 1}-h`}>
                <h2 id={`s-${i + 1}-h`}>
                  <a className="anchor" href={`#s-${i + 1}`} aria-hidden="true" tabIndex={-1}>
                    #
                  </a>
                  {s.h}
                </h2>
                {s.p.map(t => (
                  <p key={t}>{t}</p>
                ))}
              </section>
            ))}
            {page === 'privacy' && (
              <p className="legal-back">
                <PageLink href={pagePath(locale, 'legal/data-deletion')}>
                  {COPY[locale].footer.dataDeletion}
                </PageLink>
              </p>
            )}
            {page === 'legal' && (
              <section id="s-office" aria-labelledby="s-office-h">
                <OfficeBlock locale={locale} headingId="s-office-h" />
              </section>
            )}
            {page === 'legal' && (
              <section id="s-more" aria-labelledby="s-more-h">
                <h2 id="s-more-h">{c.more.h}</h2>
                <ul>
                  {c.more.links.map(l => (
                    <li key={l.slug}>
                      <PageLink href={pagePath(locale, l.slug as LegalExtraSlug)}>
                        {l.label}
                      </PageLink>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="legal-back">
              <PageLink href={HOME[locale]}>{c.back}</PageLink>
            </p>
          </article>
        </div>
      </main>
      <Footer locale={locale} page={page} />
    </>
  );
}
