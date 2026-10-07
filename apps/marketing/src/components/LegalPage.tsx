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
        <header className="legal-head">
          <h1>{doc.title}</h1>
          <p className="legal-meta">
            {c.updated.label} <time dateTime="2026-10-07">{c.updated.date}</time> ·{' '}
            {c.updated.version}
          </p>
          <p className="legal-notice">{c.notice}</p>
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
            <p className="legal-back">
              <Link href={HOME[locale]}>{c.back}</Link>
            </p>
          </article>
        </div>
      </main>
      <Footer locale={locale} />
    </>
  );
}
