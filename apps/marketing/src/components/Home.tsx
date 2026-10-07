import { Fragment } from 'react';
import { BRAND } from '@force/shared/brand';
import { COPY } from '../lib/content';
import { PLANS, PRICING_PLACEHOLDER, PRICING_PUBLISHED } from '../lib/plans';
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
import { NileNight } from './NileNight';
import { HERO_POSTER_SVG } from '../lib/hero-poster';
import { jsonLd } from '../lib/seo';

/** EGP with Western digits: "1,490 ج.م" in Arabic, "EGP 1,490" in English. */
export function egp(locale: Locale, pounds: number): string {
  const n = pounds.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return locale === 'ar' ? `${n} ج.م` : `EGP ${n}`;
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

function Phone({ locale }: { locale: Locale }) {
  const p = COPY[locale].features.phone;
  return (
    <figure className="phone-fig">
      <div className="phone" role="img" aria-label={p.label}>
        <div className="phone-screen" aria-hidden="true">
          <div className="phone-bar">
            <span className="phone-url" dir="ltr">
              {p.slug}
              {BRAND.domains.storeSuffix}
            </span>
          </div>
          <div className="shop-head">
            <span className="shop-mark">{p.store.charAt(0)}</span>
            <span className="shop-name">{p.store}</span>
          </div>
          <ul className="shop-grid">
            {p.products.map(item => (
              <li key={item.name}>
                <span className={`shop-img tone-${item.tone}`} />
                <span className="shop-item">{item.name}</span>
                <span className="shop-price">{egp(locale, item.price)}</span>
              </li>
            ))}
          </ul>
          <div className="shop-foot">
            <span className="shop-cod">{p.cod}</span>
            <span className="shop-wa">{p.order}</span>
          </div>
        </div>
      </div>
      <figcaption className="muted small">{p.caption}</figcaption>
    </figure>
  );
}

export function Home({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const rtl = locale === 'ar';
  const renderers: Record<SectionId, () => React.ReactNode> = {
    how: () => (
      <Section id="how" title={c.how.title}>
        <ol className="steps">
          {c.how.steps.map((s, i) => (
            <li key={s.t}>
              <span className="step-n" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ol>
      </Section>
    ),
    features: () => (
      <Section id="features" title={c.features.title} className="features">
        <div className="features-grid">
          <Phone locale={locale} />
          <ul className="feature-list">
            {c.features.items.map(f => (
              <li key={f.t}>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    ),
    payments: () => (
      <Section id="payments" title={c.payments.title}>
        <ul className="ledger">
          {c.payments.methods.map(m => (
            <li key={m.name} data-status={m.status}>
              <h3>{m.name}</h3>
              <p>{m.desc}</p>
              <span className={`badge badge-${m.status}`}>{c.status[m.status]}</span>
            </li>
          ))}
        </ul>
        <p className="muted">{c.payments.note}</p>
      </Section>
    ),
    pricing: () => (
      <Section id="pricing" title={c.pricing.title}>
        <p className="lead">{c.pricing.lead}</p>
        <ul className="plans">
          {PLANS.map(p => (
            <li key={p.id} className="plan" data-plan={p.id}>
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
        <p className="muted small">{c.pricing.note}</p>
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
            <h1 id="hero-h">{c.hero.h1}</h1>
            <p className="hero-sub">{c.hero.sub}</p>
            <p className="actions">
              <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
                {c.hero.cta}
              </a>
              <a href="#how" className="btn btn-ghost btn-lg">
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
