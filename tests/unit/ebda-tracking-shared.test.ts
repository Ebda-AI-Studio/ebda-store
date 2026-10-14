/**
 * Ebda own-ads tracking: the pure shared pieces (consent cookie, attribution capture,
 * event ids, funnel table). packages/shared/src/tracking/*
 */
import { describe, it, expect } from 'vitest';
import {
  EBDA_ATTRIBUTION_MAX_AGE_DAYS,
  EBDA_FUNNEL,
  buildFbc,
  captureAttribution,
  hasAnyConsent,
  parseAttribution,
  parseConsent,
  purchaseEventId,
  registrationEventId,
  sanitizeAttribution,
  serializeAttribution,
  serializeConsent,
  storeCreatedEventId,
} from '@force/shared';

const NOW = 1_800_000_000_000;

describe('consent cookie', () => {
  it('round-trips a choice', () => {
    const c = parseConsent(serializeConsent({ analytics: true, marketing: false }));
    expect(c).toEqual({ v: 1, analytics: true, marketing: false });
  });
  it.each([
    undefined,
    null,
    '',
    'garbage',
    encodeURIComponent('{"v":2,"analytics":true,"marketing":true}'),
    encodeURIComponent('{"v":1,"analytics":"yes"}'),
  ])('treats %s as no decision', raw => {
    expect(parseConsent(raw)).toBeNull();
    expect(hasAnyConsent(parseConsent(raw))).toBe(false);
  });
  it('a decline is a decision but allows nothing', () => {
    const c = parseConsent(serializeConsent({ analytics: false, marketing: false }));
    expect(c).not.toBeNull();
    expect(hasAnyConsent(c)).toBe(false);
  });
});

describe('attribution capture', () => {
  const base = { pathname: '/', referrer: '', now: NOW, existing: null };

  it('keeps utm_* and fbclid from a first landing, with fbc in Meta cookie format', () => {
    const a = captureAttribution({
      ...base,
      search:
        '?utm_source=meta&utm_medium=paid&utm_campaign=launch&utm_content=v1&utm_term=store&fbclid=IwAR123',
    })!;
    expect(a).toMatchObject({
      utm_source: 'meta',
      utm_medium: 'paid',
      utm_campaign: 'launch',
      utm_content: 'v1',
      utm_term: 'store',
      fbclid: 'IwAR123',
      fbc: `fb.1.${NOW}.IwAR123`,
      landing: '/',
      first_seen: NOW,
    });
  });
  it('records an organic first visit with its referrer host (no query string leaks into landing)', () => {
    const a = captureAttribution({
      ...base,
      pathname: '/en',
      search: '?x=1',
      referrer: 'https://www.google.com/search?q=secret',
    })!;
    expect(a.landing).toBe('/en');
    expect(a.referrer).toBe('www.google.com');
    expect(a.utm_source).toBeUndefined();
  });
  it('first touch wins: a later visit with different utm changes nothing', () => {
    const first = captureAttribution({ ...base, search: '?utm_source=meta' })!;
    expect(
      captureAttribution({
        ...base,
        existing: first,
        now: NOW + 1000,
        search: '?utm_source=tiktok',
      })
    ).toBeNull();
  });
  it('an ad click replaces an organic first touch (first PAID touch wins)', () => {
    const organic = captureAttribution({ ...base, search: '' })!;
    const next = captureAttribution({
      ...base,
      existing: organic,
      now: NOW + 5,
      search: '?utm_source=meta&fbclid=abc',
    })!;
    expect(next.utm_source).toBe('meta');
    expect(next.fbclid).toBe('abc');
  });
  it('a NEW fbclid refreshes the click id but keeps the original utm', () => {
    const first = captureAttribution({ ...base, search: '?utm_source=meta&fbclid=one' })!;
    const next = captureAttribution({
      ...base,
      existing: first,
      now: NOW + 9,
      search: '?fbclid=two',
    })!;
    expect(next.utm_source).toBe('meta');
    expect(next.fbclid).toBe('two');
    expect(next.fbc).toBe(`fb.1.${NOW + 9}.two`);
    expect(next.first_seen).toBe(NOW);
  });
  it('strips control characters and caps length', () => {
    const a = captureAttribution({
      ...base,
      search: `?utm_source=${encodeURIComponent('me\u0000ta\n')}&utm_campaign=${'x'.repeat(500)}`,
    })!;
    expect(a.utm_source).toBe('meta');
    expect(a.utm_campaign).toHaveLength(200);
  });
  it('survives the cookie round trip and rejects tampered cookies', () => {
    const a = captureAttribution({ ...base, search: '?utm_source=meta' })!;
    expect(parseAttribution(serializeAttribution(a))).toEqual(a);
    expect(parseAttribution('%7Bnot json')).toBeNull();
    expect(parseAttribution(encodeURIComponent('{"utm_source":"x"}'))).toBeNull(); // no first_seen
  });
  it('sanitizeAttribution drops unknown keys', () => {
    expect(
      sanitizeAttribution({ first_seen: 1, utm_source: 'a', evil: '<script>', fbc: 5 })
    ).toEqual({
      first_seen: 1,
      utm_source: 'a',
    });
  });
  it('is a 90 day cookie', () => expect(EBDA_ATTRIBUTION_MAX_AGE_DAYS).toBe(90));
  it('buildFbc floors the timestamp', () => expect(buildFbc('id', 12.9)).toBe('fb.1.12.id'));
});

describe('event ids (browser <-> server dedup)', () => {
  it('derive deterministically from the record id, so both sides agree', () => {
    expect(registrationEventId('u1')).toBe('reg_u1');
    expect(registrationEventId('u1')).toBe(registrationEventId('u1'));
    expect(storeCreatedEventId('s1')).toBe('store_s1');
    expect(purchaseEventId('b1')).toBe('sub_b1');
  });
  it('never collide across event kinds', () => {
    expect(
      new Set([registrationEventId('x'), storeCreatedEventId('x'), purchaseEventId('x')]).size
    ).toBe(3);
  });
});

describe('funnel table', () => {
  it('maps to the Meta standard names Ahmad asked for', () => {
    expect(EBDA_FUNNEL.page_view.meta).toBe('PageView');
    expect(EBDA_FUNNEL.pricing_viewed.meta).toBe('ViewContent');
    expect(EBDA_FUNNEL.signup_submitted.meta).toBe('Lead');
    expect(EBDA_FUNNEL.registration_completed.meta).toBe('CompleteRegistration');
    expect(EBDA_FUNNEL.store_created).toMatchObject({ meta: 'StoreCreated', metaCustom: true });
    expect(EBDA_FUNNEL.subscription_paid.meta).toBe('Purchase');
  });
});
