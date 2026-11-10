import { PageLink } from './PageLink';
import { BRAND } from '@ebda/shared/brand';
import { COPY } from '../lib/content';
import { serviceLineJsonLd } from '../lib/seo';
import { SERVICE_LINE_CONTENT, type LineId } from '../lib/service-lines-content';
import { serviceLinesPublished } from '../lib/service-lines';
import { LINE_POWERED, LINE_UI } from '../lib/services-page';
import { pagePath, type Locale } from '../lib/site';
import '@/app/services.css';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { Reveal } from './Motion';

const MOTIFS = ['ab-m8', 'ab-mr', 'ab-mq', 'ab-m8'] as const;

/** A generated photograph with its "illustrative" caption (the pictures are not real projects). */
function Photo({
  id,
  name,
  alt,
  locale,
  hero = false,
  sizes,
}: {
  id: string;
  name: string;
  alt: string;
  locale: Locale;
  hero?: boolean;
  sizes?: string;
}) {
  const w = hero ? 832 : 1216;
  const h = hero ? 1040 : 832;
  const small = `/services/${name}-640.webp`;
  return (
    <figure className={`sv-ph${hero ? ' sv-ph-hero' : ''}`} id={id}>
      <img
        src={small}
        srcSet={`${small} 640w, /services/${name}-${w}.webp ${w}w`}
        sizes={sizes ?? (hero ? '(min-width: 900px) 40vw, 92vw' : '(min-width: 900px) 50vw, 92vw')}
        width={w}
        height={h}
        alt={alt}
        {...(hero
          ? { fetchPriority: 'high' as const }
          : { loading: 'lazy' as const, decoding: 'async' as const })}
      />
      <figcaption className="muted small">{LINE_UI[locale].illustrative}</figcaption>
    </figure>
  );
}

/**
 * One service line of the studio (Marketing, Design, Events), a single page: hero, the path (the line's signature visual), what we do
 * (grouped), how we work, why us (the AI + software edge), FAQ, contact CTA. Ruling SERVICES-IA-1. Accent: Marketing silver, Design
 * brass, Events gold (css/services.css, `sv-<id>`). Copy: lib/service-lines-content.ts (DRAFT until approved).
 */
export function ServiceLinePage({ locale, id }: { locale: Locale; id: LineId }) {
  const site = SERVICE_LINE_CONTENT[id];
  const c = site[locale];
  const u = LINE_UI[locale];
  const line = BRAND.serviceLines.find(l => l.id === id)!;
  const name = locale === 'ar' ? line.ar : line.en;
  const page = `services/${id}` as const;
  const contactHref = `${pagePath(locale, 'contact')}/?topic=${id}#form`;
  return (
    <>
      <a href="#main" className="skip">
        {COPY[locale].skip}
      </a>
      {serviceLinesPublished() && <JsonLd data={serviceLineJsonLd(locale, id)} />}
      <Header locale={locale} page={page} />
      <main id="main" className={`sv sv-${id}`}>
        <section className="sv-hero band-dark" aria-labelledby="sv-h1">
          <div className="wrap sv-hero-grid">
            <div className="sv-hero-copy">
              <p className="sv-crumb">
                <PageLink href={`${pagePath(locale, 'services')}/`}>{u.back}</PageLink>
                <span aria-hidden="true"> / </span>
                <span>{name}</span>
              </p>
              <p className="sv-eyebrow">{c.tagline}</p>
              <h1 id="sv-h1">{c.hero.h1}</h1>
              <p className="sv-lead">{c.hero.lead}</p>
              <p className="actions">
                <PageLink href={contactHref} className="btn btn-primary btn-lg sv-cta">
                  {c.hero.cta}
                </PageLink>
              </p>
            </div>
            <Photo id="sv-hero-img" name={site.images.hero} alt={c.alt.hero} locale={locale} hero />
          </div>
        </section>

        <section className="sv-pathsec" aria-labelledby="sv-path-h">
          <div className="wrap">
            <h2 className="ab-h2" id="sv-path-h">
              {c.path.label}
            </h2>
            <p className="sv-statement">{c.path.statement}</p>
            <Reveal>
              <ol className="sv-path" style={{ ['--n' as string]: c.path.items.length }}>
                {c.path.items.map((s, i) => (
                  <li key={s.t} style={{ ['--i' as string]: i }}>
                    <span className="sv-mark" aria-hidden="true" />
                    <h3>{s.t}</h3>
                    <p>{s.d}</p>
                  </li>
                ))}
              </ol>
            </Reveal>
          </div>
        </section>

        <section className={`ab-sec ${MOTIFS[0]}`} aria-labelledby="sv-what-h" id="what">
          <div className="wrap">
            <h2 className="ab-h2" id="sv-what-h">
              {u.whatH}
            </h2>
            <p className="sv-statement">{c.what.statement}</p>
            <div className="sv-groups">
              {c.what.groups.map(g => (
                <section key={g.id} className="sv-group" aria-labelledby={`sv-g-${g.id}`}>
                  <h3 id={`sv-g-${g.id}`}>{g.title}</h3>
                  <p className="muted">{g.intro}</p>
                  <ul className="sv-items">
                    {g.items.map(it => (
                      <li key={it.t}>
                        <b>{it.t}</b>
                        <span>{it.d}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <Photo id="sv-img-a" name={site.images.a} alt={c.alt.a} locale={locale} sizes="92vw" />
          </div>
        </section>

        <section className={`ab-sec ${MOTIFS[1]}`} aria-labelledby="sv-how-h" id="how">
          <div className="wrap sv-split">
            <div>
              <h2 className="ab-h2" id="sv-how-h">
                {u.howH}
              </h2>
              <p className="sv-statement">{c.how.statement}</p>
              <ol className="sv-steps">
                {c.how.steps.map(s => (
                  <li key={s.t}>
                    <h3>{s.t}</h3>
                    <p>{s.d}</p>
                  </li>
                ))}
              </ol>
            </div>
            <aside className="sv-get" aria-labelledby="sv-get-h">
              <h3 id="sv-get-h">{c.how.getLabel}</h3>
              <ul>
                {c.how.get.map(g => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
              <Photo
                id="sv-img-b"
                name={site.images.b}
                alt={c.alt.b}
                locale={locale}
                sizes="(min-width: 900px) 40vw, 92vw"
              />
            </aside>
          </div>
        </section>

        <section className={`ab-sec ${MOTIFS[2]}`} aria-labelledby="sv-why-h" id="why">
          <div className="wrap">
            <h2 className="ab-h2" id="sv-why-h">
              {u.whyH}
            </h2>
            <p className="sv-statement">{c.why.statement}</p>
            <div className="sv-split">
              <div>
                <h3 className="sv-sub">{c.why.edgeLabel}</h3>
                <ul className="sv-points">
                  {c.why.points.map(p => (
                    <li key={p.t}>
                      <b>{p.t}</b>
                      <span>{p.d}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="sv-sub">{c.why.notLabel}</h3>
                <ul className="sv-not">
                  {c.why.not.map(n => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <p className="wrap sv-powered muted small" data-powered={id}>
          {LINE_POWERED[locale][id].text}{' '}
          <PageLink href={`${pagePath(locale, '')}${locale === 'ar' ? '' : '/'}#products`}>
            {LINE_POWERED[locale][id].link}
          </PageLink>
        </p>

        <section className={`ab-sec ${MOTIFS[3]} faq`} aria-labelledby="sv-faq-h" id="faq">
          <div className="wrap sv-faq">
            <div>
              <h2 className="ab-h2" id="sv-faq-h">
                {u.faqH}
              </h2>
              <p className="sv-statement">{u.faqLead}</p>
            </div>
            <div>
              {c.faq.map(f => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="sv-close band-dark" aria-labelledby="sv-close-h" id="contact">
          <div className="wrap sv-close-grid">
            <div>
              <h2 id="sv-close-h">{c.closer.h}</h2>
              <p className="sv-lead">{c.closer.p}</p>
              <p className="actions">
                <PageLink href={contactHref} className="btn btn-primary btn-lg sv-cta">
                  {u.contactCta}
                </PageLink>
              </p>
              <p className="sv-mail">
                {u.emailLead}{' '}
                <a href={`mailto:${BRAND.supportEmail}`} dir="ltr">
                  {BRAND.supportEmail}
                </a>
              </p>
            </div>
            <div>
              <h3 className="sv-sub">{u.nextH}</h3>
              <ol className="sv-next">
                {c.next.map(n => (
                  <li key={n.t}>
                    <b>{n.t}</b>
                    <span>{n.d}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>
      </main>
      <Footer locale={locale} page={page} />
    </>
  );
}
