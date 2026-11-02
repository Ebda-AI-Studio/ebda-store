import { BRAND } from '@ebda/shared/brand';
import type { Locale } from './site';

/**
 * Copy of the Ebda AI Studio home (`/`, `/en`), Ruling MKT-HOME-1. Product names and blurbs come from BRAND and the nav copy;
 * only the studio-level sentences live here. Only products that are live are listed (BRAND-ARCH-1): no CRM / ERP until they ship.
 */
export interface StudioHome {
  meta: { title: string; desc: string };
  eyebrow: string;
  h1: string;
  lead: string;
  productsH: string;
  store: { blurb: string; cta: string; more: string };
  chat: { blurb: string; cta: string; more: string };
  account: string;
}

const STUDIO_AR = BRAND.company.shortNameAr;
const STUDIO_EN = BRAND.company.shortNameEn;
const STORE_AR = BRAND.product.nameAr;
const STORE_EN = BRAND.product.nameEn;
const CHAT_AR = BRAND.productWhatsapp.nameAr;
const CHAT_EN = BRAND.productWhatsapp.nameEn;

export const STUDIO_HOME: Record<Locale, StudioHome> = {
  ar: {
    meta: {
      title: `${STUDIO_AR}: ${STORE_AR} و${CHAT_AR}`,
      desc: `${STUDIO_AR} بيعمل برامج للتجار في مصر: ${STORE_AR} لمتجرك على الإنترنت، و${CHAT_AR} لعملائك على واتساب. حساب واحد للاتنين.`,
    },
    eyebrow: STUDIO_AR,
    h1: 'متجرك وعملاؤك في مكان واحد.',
    lead: `${STORE_AR} بيفتحلك متجر على الإنترنت، و${CHAT_AR} بيكلّم عملاءك على واتساب. بتدخل للاتنين بنفس الحساب.`,
    productsH: 'منتجاتنا',
    store: {
      blurb: 'متجرك على الإنترنت في دقايق، بالعربي وبشكل يشبهك.',
      cta: 'افتح متجرك',
      more: `اعرف أكتر عن ${STORE_AR}`,
    },
    chat: {
      blurb: 'بيع ورد على عملائك على واتساب من مكان واحد.',
      cta: `ابدأ مع ${CHAT_AR}`,
      more: `اعرف أكتر عن ${CHAT_AR}`,
    },
    account: 'حساب واحد للاتنين، من غير باسورد تاني.',
  },
  en: {
    meta: {
      title: `${STUDIO_EN}: ${STORE_EN} and ${CHAT_EN}`,
      desc: `${STUDIO_EN} builds software for merchants in Egypt: ${STORE_EN} for your online store and ${CHAT_EN} for your customers on WhatsApp. One account for both.`,
    },
    eyebrow: STUDIO_EN,
    h1: 'Your store and your customers, in one place.',
    lead: `${STORE_EN} opens your online store, and ${CHAT_EN} talks to your customers on WhatsApp. You sign in to both with the same account.`,
    productsH: 'Our products',
    store: {
      blurb: 'Your online store in minutes, in Arabic and in your own style.',
      cta: 'Open your store',
      more: `Learn more about ${STORE_EN}`,
    },
    chat: {
      blurb: 'Sell and support your customers on WhatsApp from one place.',
      cta: `Start with ${CHAT_EN}`,
      more: `Learn more about ${CHAT_EN}`,
    },
    account: 'One account for both, no second password.',
  },
};
