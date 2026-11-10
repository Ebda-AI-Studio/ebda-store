import { SiteLink } from './SiteLink';
import { PageLink } from './PageLink';
import { COMPARE, COMPARE_PAGE, compareRows, type ResolvedRow } from '../lib/compare';
import { COMING_LABEL } from '../lib/capability-registry';
import { COPY } from '../lib/content';
import { jsonLd } from '../lib/seo';
import { SIGNUP_URL, pagePath, type CompareSlug, type Locale } from '../lib/site';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';

function Table({
  locale,
  slug,
  rows,
  heading,
  id,
}: {
  locale: Locale;
  slug: CompareSlug;
  rows: readonly ResolvedRow[];
  heading: string;
  id: string;
}) {
  const def = COMPARE[slug];
  const k = COMPARE_PAGE[locale];
  return (
    <section className="page-sec" aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      <div className="cmp-wrap">
        <table className="cmp">
          <caption>{heading}</caption>
          <thead>
            <tr>
              <th scope="col">{k.colWhat}</th>
              <th scope="col">{k.colEbda}</th>
              <th scope="col">{def[locale].name}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const cell = def.cells[r.id];
              return (
                <tr key={r.id} data-verdict={cell.v}>
                  <th scope="row">{r.label[locale]}</th>
                  <td data-label={k.colEbda}>
                    {r.soon && <span className="cap-badge">{COMING_LABEL[locale]}</span>}
                    {r.ebda[locale]}
                  </td>
                  <td data-label={def[locale].name}>
                    {cell.text[locale]}
                    <span className="cmp-verdict"> · {k.verdict[cell.v]}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ComparePage({ locale, slug }: { locale: Locale; slug: CompareSlug }) {
  const d = COMPARE[slug][locale];
  const k = COMPARE_PAGE[locale];
  const rows = compareRows();
  const sources = COMPARE[slug].sources;
  return (
    <>
      <a href="#main" className="skip">
        {COPY[locale].skip}
      </a>
      <JsonLd data={jsonLd(locale, [])} />
      <Header locale={locale} page={`compare/${slug}`} />
      <main id="main" className="wrap page">
        <header className="page-head">
          <h1>{d.h1}</h1>
          <p className="lead">{d.intro}</p>
          <p className="muted small">{k.asOf}</p>
        </header>
        <section className="page-sec choose" aria-label={d.h1}>
          <div>
            <h2>{d.chooseEbdaH}</h2>
            <ul className="more-list">
              {d.chooseEbda.map(t => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div>
            <h2>{d.chooseThemH}</h2>
            <ul className="more-list">
              {d.chooseThem.map(t => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </section>
        <Table locale={locale} slug={slug} rows={rows.strength} heading={k.strongH} id="strong-h" />
        <Table locale={locale} slug={slug} rows={rows.gap} heading={k.gapH} id="gap-h" />
        <p className="muted small">{k.verify}</p>
        {sources && (
          <p className="muted small">
            {k.sourcesH}{' '}
            {sources.map((src, i) => (
              <span key={src.href}>
                {i > 0 && ' · '}
                <SiteLink href={src.href} locale={locale}>
                  {src.name}
                </SiteLink>
              </span>
            ))}
          </p>
        )}
        <p className="actions">
          <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary btn-lg">
            {k.cta}
          </SiteLink>
          <PageLink href={pagePath(locale, 'features')} className="btn btn-ghost btn-lg">
            {k.allFeatures}
          </PageLink>
        </p>
      </main>
      <Footer locale={locale} />
    </>
  );
}
