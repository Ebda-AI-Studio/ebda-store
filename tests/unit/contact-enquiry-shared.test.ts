import { describe, it, expect } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand';
import {
  CONTACT_TOPIC_IDS,
  CONTACT_TOPIC_LABELS,
  formatPhoneDisplay,
  normalizeEmail,
  normalizePhone,
} from '../../packages/shared/src/contact-enquiry';

describe('contact enquiry contract', () => {
  it('topics are the two supports, all seven BRAND services, and other, each with ar + en labels', () => {
    expect(CONTACT_TOPIC_IDS).toHaveLength(2 + BRAND.services.length + 1);
    expect(BRAND.services).toHaveLength(7);
    for (const t of CONTACT_TOPIC_IDS) {
      expect(CONTACT_TOPIC_LABELS[t].ar).toBeTruthy();
      expect(CONTACT_TOPIC_LABELS[t].en).toBeTruthy();
    }
  });
  it.each([
    ['01012345678', '+201012345678'],
    ['+20 101 234 5678', '+201012345678'],
    ['0020-101-2345678', '+201012345678'],
    ['٠١٢٢٣٣٤٤٥٥٦', '+201223344556'],
    ['+971501234567', '+971501234567'],
  ])('normalises %s', (raw, out) => expect(normalizePhone(raw)).toBe(out));
  it.each(['0123', '01312345678', 'abc', '+0123456789', ''])('rejects phone %s', raw =>
    expect(normalizePhone(raw)).toBeNull()
  );
  it('formats phones like whatsappDisplay()', () => {
    expect(formatPhoneDisplay('+201012345678')).toBe('+20 101 234 5678');
  });
  it('normalises and rejects emails', () => {
    expect(normalizeEmail(' A@B.com ')).toBe('a@b.com');
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('a b@c.com')).toBeNull();
  });
});
