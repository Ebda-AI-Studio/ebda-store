import { describe, expect, it } from 'vitest';
import { PROTECTED_PAGE_SLUGS, canDeletePage } from './pages.service';

describe('canDeletePage', () => {
  it('a store admin deletes custom pages, Arabic slugs included', () => {
    expect(canDeletePage('store_admin', 'qa-test-page')).toBe(true);
    expect(canDeletePage('store_admin', 'صفحة-اختبار')).toBe(true);
  });
  it('standard pages are protected from a store admin, any case or padding', () => {
    for (const s of PROTECTED_PAGE_SLUGS) expect(canDeletePage('store_admin', s)).toBe(false);
    expect(canDeletePage('store_admin', ' Privacy ')).toBe(false);
  });
  it('only the two admin roles, super admin may remove a shell', () => {
    expect(canDeletePage('super_admin', 'privacy')).toBe(true);
    expect(canDeletePage('customer', 'qa-test-page')).toBe(false);
    expect(canDeletePage(undefined, 'qa-test-page')).toBe(false);
  });
});
