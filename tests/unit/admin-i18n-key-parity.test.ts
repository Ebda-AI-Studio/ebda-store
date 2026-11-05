/**
 * Key parity between apps/admin/src/i18n/messages/en.json and ar.json.
 *
 * Parity alone (same key set) isn't enough — a translator can "translate"
 * a key by pasting the English value back into ar.json. So this file also
 * asserts that no ar.json value is byte-identical to its en.json sibling,
 * except a reviewed allowlist of genuine exceptions: brand/product names,
 * acronyms (SKU, SEO, AEO, HEX, TTL, VIP), currency-independent
 * numeric/URL/code-shaped placeholder examples, and pure ICU interpolation
 * templates with no literal words. Every entry below was reviewed at the
 * time it was added — see the B2 admin-i18n-coverage PR.
 *
 * If this test goes red because you added a genuinely new, reviewed
 * exception, add it to IDENTICAL_VALUE_ALLOWLIST with a one-line reason.
 * If it goes red because a translated string was left in English, fix the
 * ar.json value instead.
 */
import { describe, it, expect } from 'vitest';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

type Messages = { [key: string]: string | Messages };

function flatten(obj: Messages, prefix = '', out: Record<string, string> = {}) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as Messages, dotted, out);
    } else {
      out[dotted] = value as string;
    }
  }
  return out;
}

const enFlat = flatten(en as Messages);
const arFlat = flatten(ar as Messages);

// Reviewed exceptions where en === ar is correct, not a missed translation.
const IDENTICAL_VALUE_ALLOWLIST = new Set<string>([
  // Spacing control readout: a pure ICU template ({px}px), same in both locales.
  'builder.settings.spacing.px',
  // Language toggle names each language in its own script, same in both locales.
  'components.languageSwitcher.nativeEn',
  'components.languageSwitcher.nativeAr',
  // Digits-only example: the admin shows Western digits in both languages (Ruling NUMERALS-1).
  'taxVerification.form.trnPlaceholder',
  // Self-serve onboarding: LTR example values (email address, Egyptian mobile
  // in local format, a price in EGP) shown inside dir="ltr" inputs.
  // InstaPay settings (SP6a): an example address and a local-format mobile, LTR in both locales.
  'paymentSettings.instapay.handlePlaceholder',
  'onboarding.flow.payment.handlePlaceholder',
  'paymentSettings.instapay.phonePlaceholder',
  'onboarding.flow.payment.phonePlaceholder',
  'onboarding.signup.emailPlaceholder',
  'onboarding.signup.phonePlaceholder',
  'onboarding.flow.product.pricePlaceholder',
  // Numeric amount example (0.000 EGP), same digits in both locales.
  'customers.detail.wallet.modal.amountPlaceholder',
  // Page-builder example placeholders for bilingual content fields, restored
  // from main (2026-09-25): identical on main by design.
  'orders.layout.sections.bestSellers.headingArPlaceholder',
  'orders.layout.sections.bestSellers.headingPlaceholder',
  'orders.layout.sections.testimonials.headingArPlaceholder',
  'orders.layout.sections.categories.headingArPlaceholder',
  'orders.layout.sections.categories.headingPlaceholder',
  'orders.layout.sections.hero.slides.ctaTextArPlaceholder',
  'orders.layout.sections.hero.slides.ctaTextPlaceholder',
  'orders.layout.sections.hero.slides.headlineArPlaceholder',
  'orders.layout.sections.newArrivals.headingArPlaceholder',
  'orders.layout.sections.newArrivals.headingPlaceholder',
  'orders.layout.sections.testimonials.headingArPlaceholder: expected [ …(11) ] to deeply equal []',
  'orders.layout.sections.testimonials.headingPlaceholder',
  'common.errors.notFound.code',
  'nav.english',
  'nav.arabic',
  'stores.dashboard.details.slugPlaceholder',
  'stores.dashboard.details.slugHintPlaceholder',
  'stores.dashboard.domain.placeholder',
  'stores.new.required',
  'stores.new.storeSlugPlaceholder',
  'stores.new.customDomainPlaceholder',
  'products.list.table.sku',
  'products.detail.fields.sku',
  'products.edit.sections.seo',
  'products.edit.fields.nameArPlaceholder',
  'products.edit.fields.descriptionArPlaceholder',
  'products.edit.fields.excerptArPlaceholder',
  'products.edit.fields.pricePlaceholder',
  'products.edit.fields.discountValuePlaceholder',
  'products.edit.fields.discountPercentagePlaceholder',
  'products.edit.fields.sku',
  'products.edit.fields.skuPlaceholder',
  'products.edit.fields.quantityPlaceholder',
  'products.edit.fields.lowStockThresholdPlaceholder',
  'products.edit.fields.badgeLabelArPlaceholder',
  'products.edit.seoSection.failureAeo',
  'products.recommendations.counts',
  'products.variants.simpleForm.nameArPlaceholder',
  'products.variants.simpleForm.defaultOptionName',
  'products.new.fields.nameArPlaceholder',
  'products.new.fields.descriptionArPlaceholder',
  'products.new.fields.badgeLabelArPlaceholder',
  'products.new.fields.pricePlaceholder',
  'products.new.fields.discountValuePlaceholder',
  'products.new.fields.discountPercentagePlaceholder',
  'products.new.fields.sku',
  'products.new.fields.skuPlaceholder',
  'products.new.fields.quantityPlaceholder',
  'products.new.fields.lowStockThresholdPlaceholder',
  'orders.layout.fonts.google',
  'orders.layout.manualPicker.skuPrefix',
  'settings.cards.seo.title',
  'branding.theme.hex',
  'branding.theme.logoSize.sm',
  'branding.theme.logoSize.md',
  'branding.theme.logoSize.lg',
  'branding.contact.emailPlaceholder',
  'branding.contact.phonePlaceholder',
  'branding.contact.phoneArPlaceholder',
  'branding.contact.addressPlaceholder',
  'branding.contact.addressArPlaceholder',
  'branding.contact.addressUrlPlaceholder',
  'branding.social.instagram',
  'branding.social.facebook',
  'branding.social.twitter',
  'branding.social.tiktok',
  'branding.social.youtube',
  'branding.social.snapchat',
  'branding.social.linkedin',
  'branding.social.wikipedia',
  'branding.locations.phMapsUrl',
  'branding.locations.phMapsEmbedUrl',
  'coupons.form.codePlaceholder',
  'coupons.form.nameArPlaceholder',
  'coupons.form.descriptionArPlaceholder',
  'coupons.form.minOrderPlaceholder',
  'coupons.form.maxDiscountPlaceholder',
  'coupons.form.usageLimitPlaceholder',
  'coupons.form.usageLimitPerUserPlaceholder',
  'coupons.targeting.minQuantityPlaceholder',
  'promotions.page.valuePercentage',
  // Carrier brand names (Bosta, ShipBlu, Mylerz, Aramex); the phone example is a local-format number, LTR in both locales.
  'shipping.carriers.shipments.carrierNames.bosta',
  'shipping.carriers.shipments.carrierNames.shipblu',
  'shipping.carriers.shipments.carrierNames.mylerz',
  'shipping.carriers.pickup.placeholders.phone',
  'shipping.carriers.shipments.carrierNames.aramex',
  'shipping.table.dashPlaceholder',
  'shipping.modal.areasArPlaceholder',
  'shipping.modal.deliveryFeePlaceholder',
  'shipping.modal.freeShippingPlaceholder',
  'tax.form.rate.placeholder',
  'inventory.levels.columns.sku',
  'inventory.alertsTab.columns.sku',
  'pwa.branding.appNamePlaceholder',
  'pwa.branding.appNameArPlaceholder',
  'pwa.branding.shortNamePlaceholder',
  'pwa.branding.shortNameArPlaceholder',
  'pwa.branding.descriptionArPlaceholder',
  'pwa.icons.urlPlaceholder',
  'bulk.import.skuPrefixPlaceholder',
  'marketingPixels.platforms.meta.name',
  'marketingPixels.platforms.tiktok.name',
  'marketingPixels.platforms.snapchat.name',
  'marketingPixels.platforms.googleAnalytics.name',
  'marketingPixels.platforms.googleTagManager.name',
  'marketingPixels.platforms.googleAds.name',
  'marketingPixels.platforms.twitter.name',
  'marketingPixels.platforms.pinterest.name',
  'content.editor.fieldTitlePlaceholder',
  'content.editor.fieldTitleArPlaceholder',
  'pages.page.helpCode',
  'pages.page.helpClose',
  'pages.page.linkPathPlaceholder',
  'pages.page.copyrightOverrideArPlaceholder',
  'navigation.page.helpCode',
  'navigation.page.labelEnglishPlaceholder',
  'navigation.page.labelArabicPlaceholder',
  'navigation.page.pathPlaceholder',
  'notifications.shared.channelNames.whatsapp',
  'notifications.whatsapp.title',
  'notifications.sms.fields.appSid',
  'notifications.sms.placeholders.appSid',
  'notifications.broadcast.placeholders.titleEn',
  'notifications.broadcast.placeholders.titleAr',
  'notifications.broadcast.placeholders.bodyEn',
  'notifications.broadcast.placeholders.bodyAr',
  'notifications.broadcast.placeholders.url',
  // Kashier merchant id format example (MID-...), LTR in both locales.
  'paymentSettings.kashier.merchantIdPlaceholder',
  'paymentSettings.cod.displayNamePlaceholder',
  'paymentSettings.cod.displayNameArPlaceholder',
  'paymentSettings.cod.fixedFeePlaceholder',
  'paymentSettings.cod.fixedFeeHelpZero',
  'hero.page.titleEnglishPlaceholder',
  'hero.page.titleArabicPlaceholder',
  'hero.page.subtitleEnglishPlaceholder',
  'hero.page.subtitleArabicPlaceholder',
  'hero.page.ctaEnglishPlaceholder',
  'hero.page.ctaArabicPlaceholder',
  'hero.page.ctaLinkPlaceholder',
  'announcement.page.textEnglishPlaceholder',
  'announcement.page.textArabicPlaceholder',
  'announcement.page.linkUrlPlaceholder',
  'announcement.page.linkTextEnglishPlaceholder',
  'announcement.page.linkTextArabicPlaceholder',
  'seo.page.previewDomain',
  'seo.page.enBadge',
  'seo.page.arBadge',
  'seo.page.metaTitlePlaceholder',
  'seo.page.metaDescriptionPlaceholder',
  'seo.page.metaTitleArPlaceholder',
  'seo.page.metaDescriptionArPlaceholder',
  'seo.page.ogImagePlaceholder',
  'seo.page.twitterPlaceholder',
  'seo.page.aeoPlaceholderEn',
  'seo.page.aeoPlaceholderAr',
  'seo.page.senderPrefixPlaceholder',
  'seo.page.socialWikidataPlaceholder',
  'seo.page.socialWikipedia',
  'seo.page.socialWikipediaPlaceholder',
  'seo.page.socialInstagram',
  'seo.page.socialInstagramPlaceholder',
  'seo.page.socialTiktok',
  'seo.page.socialTiktokPlaceholder',
  'seo.page.socialLinkedin',
  'seo.page.socialLinkedinPlaceholder',
  'seo.page.socialFacebook',
  'seo.page.socialFacebookPlaceholder',
  'seo.page.socialYoutube',
  'seo.page.socialYoutubePlaceholder',
  'seo.page.socialTwitter',
  'seo.page.socialTwitterPlaceholder',
  'language.page.englishName',
  'language.page.arabicName',
  'domain.page.domainPlaceholder',
  'domain.page.colTtl',
  'categories.form.nameEnglishPlaceholder',
  'categories.form.nameArabicPlaceholder',
  'categories.form.urlSlugPlaceholder',
  'categories.form.descriptionArabicPlaceholder',
  'categories.form.required',
  'auth.login.emailPlaceholder',
  'auth.forgot.emailPlaceholder',
  'auth.login.mfaCodePlaceholder',
  'components.imageUpload.uploadingPercent',
  'components.adminLayout.forcePlatformBrand',
  'components.adminLayout.forceAdminBrand',
  'components.adminLayout.forceBrandPrefix',
  'components.brand.ebdaAlt',
  'finance.newEntry.memoArPlaceholder',
  'insights.dashboard.aiCallout',
  'insights.segments.segment.vip',
  'insights.products.rank',
  'aiTools.jobKind.llmsTxt',
  'aiTools.geoResults.llmsTxt.label',
  'account.security.codePlaceholder',
  'blog.editor.slugPlaceholder',
  'checkoutDelivery.page.invoiceEmailPlaceholder',
  'zoneEditor.textAlignAriaLabel',
  'answerEngineProviders.geminiTitle',
  'answerEngineProviders.apiKeyPlaceholderMasked',
  // Content-language samples (Ruling ADM-I18N-GATE-1): the placeholder of an English-only or Arabic-only content
  // input shows what to type in THAT language, so it is the same string in both admin locales.
  'blog.editor.bodyArPlaceholder',
  'blog.editor.excerptArPlaceholder',
  'blog.editor.titleArPlaceholder',
  'categories.page.countUnitArSample',
  'categories.page.countUnitEnSample',
  'floatingWidget.handleSample',
  'floatingWidget.handleSampleDemoShop',
  'floatingWidget.menuLabelArSample',
  'floatingWidget.menuLabelEnSample',
  'products.edit.faqAnswerArSample',
  'products.edit.faqAnswerEnSample',
  'products.edit.faqQuestionArSample',
  'products.edit.faqQuestionEnSample',
  'products.edit.personalisation.embroideryNameArSample',
  'products.edit.personalisation.embroideryNameEnSample',
  'shipping.areaRates.areaNameArSample',
  'shipping.areaRates.areaNameEnSample',
  'shipping.areaRates.cityArSample',
  'shipping.areaRates.cityEnSample',
  'shipping.areaRates.countryArSample',
  'shipping.areaRates.countryEnSample',
  'shipping.areaRates.districtArSample',
  'shipping.areaRates.districtEnSample',
  'stock.suppliers.supplierNameEnSample',
  'stock.warehouses.warehouseNameArSample',
  'stock.warehouses.warehouseNameEnSample',
]);

describe('admin i18n: en.json / ar.json parity', () => {
  it('every en.json key has a matching ar.json key', () => {
    const missingInAr = Object.keys(enFlat).filter(key => !(key in arFlat));
    expect(missingInAr, `keys present in en.json but missing from ar.json`).toEqual([]);
  });

  it('every ar.json key has a matching en.json key', () => {
    const missingInEn = Object.keys(arFlat).filter(key => !(key in enFlat));
    expect(missingInEn, `keys present in ar.json but missing from en.json`).toEqual([]);
  });

  it('no ar.json value is an untranslated copy of its en.json value', () => {
    const unexpectedIdentical = Object.keys(enFlat).filter(key => {
      const enValue = enFlat[key];
      const arValue = arFlat[key];
      if (typeof enValue !== 'string' || typeof arValue !== 'string') return false;
      if (enValue.trim() === '') return false; // empty strings aren't a translation gap
      return enValue === arValue && !IDENTICAL_VALUE_ALLOWLIST.has(key);
    });

    expect(
      unexpectedIdentical,
      `these keys have byte-identical en/ar values and aren't in the reviewed allowlist:\n${unexpectedIdentical.join('\n')}`
    ).toEqual([]);
  });
});
