import { describe, expect, it } from 'vitest';
import {
  PAGE_SLUG_REGEX,
  PROTECTED_PAGE_SLUGS as UI,
  isProtectedPageSlug,
  slugFromTitle,
} from './page-slug';
import { PROTECTED_PAGE_SLUGS as API } from '../../../../../../api/src/services/pages.service';

describe('page slug from a title', () => {
  it('keeps Arabic letters like the product slug', () => {
    expect(slugFromTitle('صفحة اختبار')).toBe('صفحة-اختبار');
    expect(PAGE_SLUG_REGEX.test('صفحة-اختبار')).toBe(true);
  });
  it('slugs English and mixed titles', () => {
    expect(slugFromTitle('Our Story!')).toBe('our-story');
    expect(slugFromTitle('عن Ebda')).toBe('عن-ebda');
  });
  it('a title with nothing usable gives no slug (the dialog then asks)', () => {
    expect(slugFromTitle('!!!')).toBe('');
  });
});

describe('protected pages', () => {
  it('UI and API lists agree', () => {
    expect([...UI].sort()).toEqual([...API].sort());
    expect(isProtectedPageSlug('Privacy')).toBe(true);
    expect(isProtectedPageSlug('qa-test-page')).toBe(false);
  });
});
