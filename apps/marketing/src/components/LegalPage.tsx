import Link from 'next/link';
import { COPY } from '../lib/content';
import { HOME, type Locale } from '../lib/site';
import { Footer } from './Footer';
import { Header } from './Header';

export function LegalPage({
  locale,
  page,
}: {
  locale: Locale;
  page: 'legal' | 'privacy' | 'terms';
}) {
  const c = COPY[locale].legalPages;
  const doc = c[page];
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
            <p>{s.p}</p>
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
