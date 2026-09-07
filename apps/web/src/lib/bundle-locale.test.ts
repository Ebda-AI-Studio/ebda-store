import { describe, it, expect } from 'vitest';
import {
  bundleDir,
  pickBundleName,
  pickBundleDescription,
  pickBundleComponentNames,
} from './bundle-locale';

const bundle = {
  name: 'Ramadan Box',
  nameAr: 'صندوق رمضان',
  description: 'A curated Ramadan gift box',
  descriptionAr: 'صندوق هدايا رمضاني مختار بعناية',
  componentNames: [
    { name: 'Dates', nameAr: 'تمر' },
    { name: 'Honey', nameAr: null }, // no Arabic name for this one component
  ],
};

describe('bundleDir', () => {
  it('is rtl for Arabic, ltr otherwise', () => {
    expect(bundleDir('ar')).toBe('rtl');
    expect(bundleDir('en')).toBe('ltr');
  });
});

describe('pickBundleName', () => {
  it('renders the Arabic name under the Arabic locale', () => {
    expect(pickBundleName(bundle, 'ar')).toBe('صندوق رمضان');
  });

  it('renders the English name under the English locale', () => {
    expect(pickBundleName(bundle, 'en')).toBe('Ramadan Box');
  });

  it('falls back to the English name in Arabic when nameAr is missing', () => {
    expect(pickBundleName({ name: 'Box', nameAr: null }, 'ar')).toBe('Box');
  });
});

describe('pickBundleDescription', () => {
  it('renders the Arabic description under the Arabic locale', () => {
    expect(pickBundleDescription(bundle, 'ar')).toBe('صندوق هدايا رمضاني مختار بعناية');
  });

  it('falls back to the English description in Arabic when descriptionAr is missing', () => {
    expect(pickBundleDescription({ description: 'Box', descriptionAr: null }, 'ar')).toBe('Box');
  });
});

describe('pickBundleComponentNames', () => {
  it('renders each component in Arabic under the Arabic locale', () => {
    expect(pickBundleComponentNames(bundle, 'ar')).toEqual(['تمر', 'Honey']);
  });

  it('falls back to the English name for a SINGLE component missing an Arabic name, without dropping the whole list', () => {
    // Honey has nameAr: null — this must not blank the whole list (unlike
    // the API's describeBundleContents, which withholds the WHOLE generated
    // sentence unless every component has an Arabic name).
    const result = pickBundleComponentNames(bundle, 'ar');
    expect(result).toHaveLength(2);
    expect(result).toContain('Honey');
  });

  it('renders each component in English under the English locale', () => {
    expect(pickBundleComponentNames(bundle, 'en')).toEqual(['Dates', 'Honey']);
  });
});
