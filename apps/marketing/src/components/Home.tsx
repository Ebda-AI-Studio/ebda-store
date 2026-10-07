import { Fragment } from 'react';
import { BRAND } from '@force/shared/brand';
import { COPY, type Provider } from '../lib/content';
import { egp } from '../lib/demo-stores';
import { HERO_POSTER_SVG } from '../lib/hero-poster';
import { PLANS, PRICING_PLACEHOLDER, PRICING_PUBLISHED, comparisonRows } from '../lib/plans';
import { jsonLd } from '../lib/seo';
import {
  FIRST_MERCHANT,
  LOGIN_URL,
  SECTION_ORDER,
  SIGNUP_URL,
  type Locale,
  type SectionId,
} from '../lib/site';
import { Footer } from './Footer';
import { Header } from './Header';
import { JsonLd } from './JsonLd';
import { About } from './About';
import { Breakout } from './Breakout';
import { Reveal, StoryScroll, TemplateShowcase } from './Motion';
import { Ring3D } from './ring/Ring3D';
import { Scenes } from './Scenes';
import { NileNight } from './NileNight';

function ProviderIcon({ kind }: { kind: 'cash' | 'truck' }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" className="mark-icon">
      {kind === 'cash' ? (
        <path
          d="M3 7h18v10H3zM7 7a4 4 0 0 1-4 4m14-4a4 4 0 0 0 4 4M7 17a4 4 0 0 0-4-4m14 4a4 4 0 0 1 4-4M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M2 6h12v10H2zM14 9h4l3 3v4h-7M6.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function Section({
  id,
  title,
  className = '',
  children,
}: {
  id: SectionId;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`section ${className}`.trim()} aria-labelledby={`${id}-h`}>
      <div className="wrap">
        <h2 id={`${id}-h`}>{title}</h2>
        {children}
      </div>
    </section>
  );
}

export function Home({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const rtl = locale === 'ar';
  const renderers: Record<SectionId, () => React.ReactNode> = {
    story: () => (
      <StoryScroll
        title={c.story.title}
        steps={c.story.steps}
        toasts={c.story.toasts}
        phoneLabel={c.story.phoneLabel}
      />
    ),
    how: () => (
      <Section id="how" title={c.how.title} className="how">
        <Reveal className="steps-wrap">
          <ol className="steps4">
            {c.how.steps.map((st, i) => (
              <li key={st.t} className="step4" style={{ '--i': i } as React.CSSProperties}>
                <span className="step4-n" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3>{st.t}</h3>
                <p>{st.d}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </Section>
    ),
    scenes: () => (
      <Section id="scenes" title={c.scenes.title} className="scenes-section">
        <p className="lead">{c.scenes.lead}</p>
        <Scenes items={c.scenes.items} />
      </Section>
    ),
    about: () => (
      <About
        title={c.about.title}
        paras={c.about.paras}
        close={c.about.close}
        markLabel={c.about.markLabel}
      />
    ),
    breakout: () => <Breakout title={c.breakout.title} words={c.breakout.words} />,
    dahab: () => (
      <Section id="dahab" title={c.dahab.title} className="dahab">
        <p className="lead">{c.dahab.lead}</p>
        <Ring3D l={c.dahab.ring} />
      </Section>
    ),
    templates: () => (
      <Section id="templates" title={c.templates.title} className="templates">
        <p className="lead">{c.templates.lead}</p>
        <TemplateShowcase
          locale={locale}
          groupLabel={c.templates.groupLabel}
          devicesLabel={c.templates.devicesLabel}
        />
      </Section>
    ),
    features: () => (
      <Section id="features" title={c.features.title}>
        <ul className="feature-list">
          {c.features.items.map(f => (
            <li key={f.t}>
              <h3>{f.t}</h3>
              <p>{f.d}</p>
            </li>
          ))}
        </ul>
      </Section>
    ),
    payments: () => (
      <Section id="payments" title={c.providers.title} className="providers">
        <dl className="rails">
          {[
            [c.providers.payLabel, c.providers.pay],
            [c.providers.shipLabel, c.providers.ship],
          ].map(([label, list]) => (
            <div key={label as string}>
              <dt>{label as string}</dt>
              <dd>
                <ul>
                  {(list as Provider[]).map(p => (
                    <li key={p.name} className="mark" data-logo={p.logo ?? 'icon'}>
                      {p.logo ? (
                        <img
                          src={`/logos/${p.logo}.webp`}
                          alt={p.name}
                          height={28}
                          width={120}
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <>
                          <ProviderIcon kind={p.icon ?? 'cash'} />
                          <span>{p.name}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ))}
        </dl>
        <p className="muted">
          {c.providers.ask} <a href={`mailto:${BRAND.supportEmail}`}>{c.providers.askLink}</a>
        </p>
      </Section>
    ),
    pricing: () => (
      <Section id="pricing" title={c.pricing.title}>
        <p className="lead">{c.pricing.lead}</p>
        <Reveal className="plans-wrap">
          <ul className="plans">
            {PLANS.map((p, i) => (
              <li
                key={p.id}
                className="plan"
                data-plan={p.id}
                style={{ '--i': i } as React.CSSProperties}
              >
                {p.id === 'growth' && <span className="plan-flag">{c.pricing.trial}</span>}
                <h3>{p.name[locale]}</h3>
                <p className="muted plan-tag">{p.tagline[locale]}</p>
                <p className="price">
                  {PRICING_PUBLISHED && p.price
                    ? egp(locale, p.price.amountMinor / 100)
                    : PRICING_PLACEHOLDER[locale]}
                  <span className="per"> {c.pricing.perMonth}</span>
                </p>
                <p className="muted small">
                  {c.pricing.annual}: {egp(locale, p.annualMinor / 100)}
                </p>
                <ul className="plan-features">
                  {p.features[locale].map(f => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <a
                  href={`${SIGNUP_URL}?plan=${p.id}&interval=month`}
                  className={`btn ${p.id === 'growth' ? 'btn-primary' : 'btn-ghost'}`}
                  data-plan-cta={p.id}
                >
                  {c.pricing.planCta.replace('{plan}', p.name[locale])}
                </a>
                <a
                  href={`${SIGNUP_URL}?plan=${p.id}&interval=year`}
                  className="plan-annual"
                  data-plan-cta-annual={p.id}
                >
                  {c.pricing.planCtaAnnual}
                </a>
              </li>
            ))}
          </ul>
        </Reveal>
        <p className="muted small">{c.pricing.note}</p>
        <div className="compare-wrap">
          <table className="compare">
            <caption>{c.pricing.compareTitle}</caption>
            <thead>
              <tr>
                <td />
                {PLANS.map(p => (
                  <th key={p.id} scope="col" data-plan={p.id}>
                    {p.name[locale]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparisonRows(locale).map(r => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  {r.cells.map((v, i) => (
                    <td key={PLANS[i].id} data-plan={PLANS[i].id}>
                      {typeof v === 'boolean' ? (
                        <span className={v ? 'yes' : 'no'} title={v ? c.pricing.yes : c.pricing.no}>
                          <span aria-hidden="true">{v ? '✓' : '–'}</span>
                          <span className="sr-only">{v ? c.pricing.yes : c.pricing.no}</span>
                        </span>
                      ) : (
                        v
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    ),
    faq: () => (
      <Section id="faq" title={c.faq.title} className="faq-section">
        <div className="faq">
          {c.faq.items.map(i => (
            <details key={i.q}>
              <summary>{i.q}</summary>
              <p>{i.a}</p>
            </details>
          ))}
        </div>
      </Section>
    ),
    start: () => (
      <Section id="start" title={c.start.title} className="closing">
        <p className="lead">{c.start.lead}</p>
        <p className="actions">
          <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
            {c.start.cta}
          </a>
          <a href={LOGIN_URL} className="btn btn-ghost btn-lg">
            {c.start.login}
          </a>
        </p>
        {FIRST_MERCHANT && (
          <p className="merchant" data-testid="first-merchant">
            <span className="muted small">{c.start.firstMerchantLabel}</span>{' '}
            <strong>{FIRST_MERCHANT.name}</strong>{' '}
            <span className="muted" dir="ltr">
              {FIRST_MERCHANT.domain}
            </span>
          </p>
        )}
      </Section>
    ),
  };

  return (
    <>
      <a href="#main" className="skip">
        {c.skip}
      </a>
      <JsonLd data={jsonLd(locale)} />
      <Header locale={locale} />
      <main id="main">
        <section className="hero" aria-labelledby="hero-h">
          <div
            className="hero-poster"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: HERO_POSTER_SVG }}
          />
          <NileNight className="nile" mirror={rtl} />
          <div className="wrap hero-inner">
            <p className="hero-brand">{c.hero.brand}</p>
            <h1 id="hero-h">{c.hero.h1}</h1>
            <p className="hero-sub">{c.hero.sub}</p>
            <p className="actions">
              <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
                {c.hero.cta}
              </a>
              <a href="#story" className="btn btn-ghost btn-lg">
                {c.hero.secondary}
              </a>
            </p>
            <p className="slug-pill">
              <span className="muted">{c.hero.slugLabel}</span>
              <span className="slug" dir="ltr">
                <span className="slug-name">yourstore</span>
                {BRAND.domains.storeSuffix}
              </span>
            </p>
          </div>
        </section>
        {SECTION_ORDER.map(id => (
          <Fragment key={id}>{renderers[id]()}</Fragment>
        ))}
      </main>
      <Footer locale={locale} />
    </>
  );
}
