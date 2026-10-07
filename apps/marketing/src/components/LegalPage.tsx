import Link from 'next/link';
import { COPY } from '../lib/content';
import { HOME, type LegalSlug, type Locale } from '../lib/site';
import type { LegalPages } from '../lib/legal-types';
import { Footer } from './Footer';
import { Header } from './Header';

const DOC_KEY: Record<
  LegalSlug,
  keyof Pick<LegalPages, 'legal' | 'privacy' | 'terms' | 'merchant' | 'acceptableUse'>
> = {
  legal: 'legal',
  privacy: 'privacy',
  terms: 'terms',
  'merchant-agreement': 'merchant',
  'acceptable-use': 'acceptableUse',
};

export function LegalPage({ locale, page }: { locale: Locale; page: LegalSlug }) {
  const c = COPY[locale].legalPages;
  const doc = c[DOC_KEY[page]];
  return (
    <>
      <Header locale={locale} page={page} />
      <main id="main" className="wrap legal">
        <p className="draft-badge" role="note">
          {c.draftBadge}
        </p>
        <h1>{doc.title}</h1>
        <p className="draft-body">{c.draftBody}</p>
        {doc.sections.map(s => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p.map(t => (
              <p key={t}>{t}</p>
            ))}
          </section>
        ))}
        <p>
          <Link href={HOME[locale]}>{c.back}</Link>
        </p>
      </main>
      <Footer locale={locale} />
    </>
  );
}
