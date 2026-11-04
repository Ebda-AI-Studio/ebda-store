import { Fragment } from 'react';
import { BRAND } from '@ebda/shared/brand';
import { COPY, type Provider } from '../lib/content';
import { egp } from '../lib/demo-stores';
import { PLANS, PRICING_PLACEHOLDER, PRICING_PUBLISHED, comparisonRows } from '../lib/plans';
import { initialLooksFragment } from '../lib/looks-initial';
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
import { LooksShowcase } from './LooksShowcase';
import { Reveal, StoryScroll } from './Motion';
import { Product3D } from './Product3D';
import { Phone } from './Devices';
import { STORY_FRAMES } from '../lib/story-frames';
import { SiteLink } from './SiteLink';
import { WhatsApp } from './WhatsApp';
import { FeatureVisuals } from './FeatureVisuals';
import { HomeCapabilities } from './Capabilities';
import { AiNative } from './AiNative';
import { FEATURES_PAGE, THEME_COPY } from '../lib/capabilities';

/** The hero phone shows the last story frame: the finished store. */
const HERO_FRAME = STORY_FRAMES[STORY_FRAMES.length - 1];

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
    model3d: () => (
      <Section id="model3d" title={c.model3d.title} className="model3d">
        <p className="lead">{c.model3d.lead}</p>
        <Product3D copy={c.model3d} locale={locale} />
      </Section>
    ),
    looks: () => (
      <Section id="looks" title={c.looks.title} className="looks">
        <p className="lead">{c.looks.lead}</p>
        <LooksShowcase copy={c.looks} rtl={rtl} initialHtml={initialLooksFragment()} />
      </Section>
    ),
    features: () => (
      <Section id="features" title={c.features.title}>
        <FeatureVisuals copy={c.features.hero} locale={locale} />
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
    ainative: () => (
      <Section id="ainative" title={THEME_COPY[locale].ai.title} className="ainative">
        <AiNative locale={locale} />
      </Section>
    ),
    capabilities: () => (
      <Section id="capabilities" title={FEATURES_PAGE[locale].homeTitle} className="capabilities">
        <HomeCapabilities locale={locale} />
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
          {c.providers.activation} {c.providers.ask}{' '}
          <a href={`mailto:${BRAND.supportEmail}`}>{c.providers.askLink}</a>
        </p>
      </Section>
    ),
    pricing: () => (
      <Section id="pricing" title={c.pricing.title}>
        <p className="lead">{c.pricing.lead}</p>
        <Reveal className="plans-wrap">
          <fieldset className="plan-pick">
            <legend>{c.pricing.pickLabel}</legend>
            {PLANS.map(p => (
              <Fragment key={p.id}>
                <input
                  type="radio"
                  name="plan-pick"
                  id={`pick-${p.id}`}
                  defaultChecked={p.id === 'growth'}
                />
                <label htmlFor={`pick-${p.id}`}>{p.name[locale]}</label>
              </Fragment>
            ))}
          </fieldset>
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
                <SiteLink
                  href={`${SIGNUP_URL}?plan=${p.id}&interval=month`}
                  locale={locale}
                  className={`btn ${p.id === 'growth' ? 'btn-primary' : 'btn-ghost'}`}
                  data-plan-cta={p.id}
                >
                  {c.pricing.planCta.replace('{plan}', p.name[locale])}
                </SiteLink>
                <SiteLink
                  href={`${SIGNUP_URL}?plan=${p.id}&interval=year`}
                  locale={locale}
                  className="plan-annual"
                  data-plan-cta-annual={p.id}
                >
                  {c.pricing.planCtaAnnual}
                </SiteLink>
              </li>
            ))}
          </ul>
        </Reveal>
        <p className="muted small">{c.pricing.note}</p>
        <details className="compare-details">
          <summary>{c.pricing.compareTitle}</summary>
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
                          <span
                            className={v ? 'yes' : 'no'}
                            title={v ? c.pricing.yes : c.pricing.no}
                          >
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
        </details>
      </Section>
    ),
    faq: () => (
      <Section id="faq" title={c.faq.title} className="faq-section">
        <div className="faq-col">
          <div className="faq">
            {c.faq.items.map(i => (
              <details key={i.q}>
                <summary>{i.q}</summary>
                <p>{i.a}</p>
              </details>
            ))}
          </div>
          <p className="faq-more">
            {c.whatsapp.faq}{' '}
            <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} locale={locale} />
          </p>
        </div>
      </Section>
    ),
    start: () => (
      <Section id="start" title={c.start.title} className="closing">
        <p className="lead">{c.start.lead}</p>
        <p className="actions">
          <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary btn-lg">
            {c.start.cta}
          </SiteLink>
        </p>
        <p className="close-wa">
          {c.whatsapp.close}{' '}
          <WhatsApp label={c.whatsapp.label} ariaLabel={c.whatsapp.aria} locale={locale} />
        </p>
        <p className="close-login">
          <SiteLink href={LOGIN_URL} locale={locale}>
            {c.start.login}
          </SiteLink>
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
      <Header locale={locale} page="store" />
      <main id="main">
        <section className="hero" aria-labelledby="hero-h">
          <div className="wrap hero-inner">
            <div className="hero-copy">
              <h1 id="hero-h">{c.hero.h1}</h1>
              <p className="hero-sub">{c.hero.sub}</p>
              <p className="hero-saving">{c.hero.saving}</p>
              <p className="actions">
                <SiteLink href={SIGNUP_URL} locale={locale} className="btn btn-primary btn-lg">
                  {c.hero.cta}
                </SiteLink>
              </p>
            </div>
            {/* Desktop only (CSS): the finished store in the same phone the story below builds, so the first screen shows the product. */}
            <div className="hero-visual" aria-hidden="true">
              <Phone className="hero-phone">
                <div className="story-screen">
                  <picture className="hero-frame">
                    <source type="image/avif" srcSet={`/devices/${HERO_FRAME.name}.avif`} />
                    <img
                      src={`/devices/${HERO_FRAME.name}.webp`}
                      width={HERO_FRAME.w}
                      height={HERO_FRAME.h}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  </picture>
                </div>
              </Phone>
            </div>
          </div>
        </section>
        {SECTION_ORDER.map(id => (
          <Fragment key={id}>{renderers[id]()}</Fragment>
        ))}
      </main>
      <Footer locale={locale} page="store" />
    </>
  );
}
