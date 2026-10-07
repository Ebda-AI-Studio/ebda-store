import { Fragment } from 'react';
import { BRAND } from '@force/shared/brand';
import { COPY, type FeatureCopy } from '../lib/content';
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
import { jsonLd } from '../lib/seo';

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: SectionId;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="section" aria-labelledby={`${id}-h`}>
      <div className="wrap">
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={`${id}-h`}>{title}</h2>
        {children}
      </div>
    </section>
  );
}

function Feature({ id, f }: { id: SectionId; f: FeatureCopy }) {
  return (
    <Section id={id} eyebrow={f.eyebrow} title={f.title}>
      <p className="lead">{f.lead}</p>
      <ul className="points">
        {f.points.map(p => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </Section>
  );
}

export function Home({ locale }: { locale: Locale }) {
  const c = COPY[locale];
  const renderers: Record<SectionId, () => React.ReactNode> = {
    create: () => (
      <Section id="create" eyebrow={c.create.eyebrow} title={c.create.title}>
        <p className="lead">{c.create.lead}</p>
        <div className="create-grid">
          <div className="slug-card">
            <span className="muted small">{c.create.slugLabel}</span>
            <span className="slug" dir="ltr">
              <span className="slug-name">yourstore</span>
              {BRAND.domains.storeSuffix}
            </span>
          </div>
          <ul className="points">
            {c.create.points.map(p => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <p>
          <a href={SIGNUP_URL} className="btn btn-primary">
            {c.create.cta}
          </a>
        </p>
      </Section>
    ),
    how: () => (
      <Section id="how" eyebrow={c.how.eyebrow} title={c.how.title}>
        <p className="lead">{c.how.lead}</p>
        <ol className="steps">
          {c.how.steps.map(s => (
            <li key={s.t}>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ol>
      </Section>
    ),
    builder: () => <Feature id="builder" f={c.builder} />,
    products: () => <Feature id="products" f={c.products} />,
    orders: () => <Feature id="orders" f={c.orders} />,
    payments: () => (
      <Section id="payments" eyebrow={c.payments.eyebrow} title={c.payments.title}>
        <p className="lead">{c.payments.lead}</p>
        <ul className="cards">
          {c.payments.methods.map(m => (
            <li key={m.name} className="card">
              <h3>{m.name}</h3>
              <p>{m.desc}</p>
              <span className={`badge badge-${m.status}`}>{c.status[m.status]}</span>
            </li>
          ))}
        </ul>
        <p className="muted">{c.payments.note}</p>
      </Section>
    ),
    whatsapp: () => (
      <Section id="whatsapp" eyebrow={c.whatsapp.eyebrow} title={c.whatsapp.title}>
        <p className="lead">{c.whatsapp.lead}</p>
        <ul className="points">
          {c.whatsapp.free.map(p => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <div className="callout">
          <h3>{c.whatsapp.laterTitle}</h3>
          <p>{c.whatsapp.later}</p>
        </div>
      </Section>
    ),
    analytics: () => <Feature id="analytics" f={c.analytics} />,
    pricing: () => (
      <Section id="pricing" eyebrow={c.pricing.eyebrow} title={c.pricing.title}>
        <p className="lead">{c.pricing.lead}</p>
        <ul className="cards plans">
          {PLANS.map(p => (
            <li key={p.id} className="card plan" data-plan={p.id}>
              <h3>{p.name[locale]}</h3>
              <p className="muted">{p.tagline[locale]}</p>
              <p className="price">
                {PRICING_PUBLISHED && p.price
                  ? new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', {
                      style: 'currency',
                      currency: 'EGP',
                    }).format(p.price.amountMinor / 100)
                  : PRICING_PLACEHOLDER[locale]}
              </p>
              <p className="muted">
                {locale === 'ar' ? 'شهريًا · سنويًا: ' : 'per month · annual: '}
                {new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', {
                  style: 'currency',
                  currency: 'EGP',
                }).format(p.annualMinor / 100)}
              </p>
              <ul className="plan-features">
                {p.features[locale].map(f => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <p className="muted">{c.pricing.note}</p>
        <p>
          <a href={SIGNUP_URL} className="btn btn-primary">
            {c.pricing.cta}
          </a>
        </p>
      </Section>
    ),
    stories: () => (
      <Section id="stories" eyebrow={c.stories.eyebrow} title={c.stories.title}>
        <p className="lead">{c.stories.lead}</p>
        <div className="card story">
          <h3>{c.stories.cardTitle}</h3>
          <p>{c.stories.cardBody}</p>
          {FIRST_MERCHANT && (
            <p className="merchant" data-testid="first-merchant">
              <span className="muted small">{c.stories.firstMerchantLabel}</span>{' '}
              <strong>{FIRST_MERCHANT.name}</strong>{' '}
              <span className="muted" dir="ltr">
                {FIRST_MERCHANT.domain}
              </span>
            </p>
          )}
        </div>
      </Section>
    ),
    faq: () => (
      <Section id="faq" eyebrow={c.faq.eyebrow} title={c.faq.title}>
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
    login: () => (
      <Section id="login" eyebrow={c.login.eyebrow} title={c.login.title}>
        <p className="lead">{c.login.lead}</p>
        <p className="actions">
          <a href={LOGIN_URL} className="btn btn-ghost">
            {c.login.login}
          </a>
          <a href={SIGNUP_URL} className="btn btn-primary">
            {c.login.start}
          </a>
        </p>
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
          <NileNight className="nile" />
          <div className="wrap hero-inner">
            <h1 id="hero-h" lang="ar" dir="rtl">
              {c.hero.h1}
            </h1>
            <p className="hero-sub" lang="en" dir="ltr">
              {c.hero.sub}
            </p>
            <p className="actions">
              <a href={SIGNUP_URL} className="btn btn-primary btn-lg">
                {c.hero.cta}
              </a>
              <a href="#how" className="btn btn-ghost btn-lg">
                {c.hero.secondary}
              </a>
            </p>
            <p className="muted hero-note">{c.hero.note}</p>
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
