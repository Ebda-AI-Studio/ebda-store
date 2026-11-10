import { SiteLink } from './SiteLink';
import { PageLink } from './PageLink';
import { COPY } from '../lib/content';
import { MODEL_CREDITS } from '../lib/credits';
import { pageJsonLd } from '../lib/seo';
import { HOME, type Locale } from '../lib/site';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';

/** /credits (Ruling MKT-12): the attribution that used to sit under the 3D viewer, linked from every footer. */
export function CreditsPage({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const p = c.creditsPage;
  return (
    <>
      <JsonLd data={pageJsonLd(locale, 'credits', p.title, p.desc)} />
      <Header locale={locale} page="credits" />
      <main id="main" className="wrap legal">
        <header className="legal-head">
          <h1>{p.title}</h1>
          <p className="legal-notice">{p.intro}</p>
        </header>
        <article className="legal-doc">
          <section aria-labelledby="credits-models-h">
            <h2 id="credits-models-h">{p.modelsH}</h2>
            <p>{p.modelsLead}</p>
            <ul className="credit-list">
              {MODEL_CREDITS.map(m => (
                <li key={m.file} data-credit={m.file}>
                  <h3>
                    <SiteLink href={m.sourceUrl} locale={locale}>
                      {m.title}
                    </SiteLink>
                  </h3>
                  <dl>
                    <div>
                      <dt>{p.author}</dt>
                      <dd>{m.author}</dd>
                    </div>
                    <div>
                      <dt>{p.source}</dt>
                      <dd>{m.sourceName}</dd>
                    </div>
                    <div>
                      <dt>{p.license}</dt>
                      <dd>
                        <SiteLink href={m.licenseUrl} locale={locale}>
                          {m.license}
                        </SiteLink>
                      </dd>
                    </div>
                    <div>
                      <dt>{p.changes}</dt>
                      <dd>
                        {p.modified}: {m.changes[locale]}
                      </dd>
                    </div>
                    <div>
                      <dt>{p.triangles}</dt>
                      <dd>{m.triangles.toLocaleString('en-US')}</dd>
                    </div>
                    <div>
                      <dt>{p.use}</dt>
                      <dd>{m.use[locale]}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="credits-photos-h">
            <h2 id="credits-photos-h">{p.photosH}</h2>
            <p>{p.photosP}</p>
          </section>
          <p className="legal-back">
            <PageLink href={HOME[locale]}>{c.legalPages.back}</PageLink>
          </p>
        </article>
      </main>
      <Footer locale={locale} />
    </>
  );
}
