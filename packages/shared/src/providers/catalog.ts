/**
 * Provider catalog: the ONE declarative list of the payment gateways and shipping carriers Ebda
 * supports, shared by the API (validation, encryption, the enable gate, webhook routing) and the
 * admin (the schema-driven "connect a provider" form). Plan:
 * docs/plans/2026-10-07-egypt-payments-shipping-integrations.md section 4; rulings PROVIDERS-1/2.
 *
 * Connecting a provider is ONLY a credentials step: the merchant picks an entry, fills the fields
 * this file declares (per mode: sandbox and live), runs Test connection, then enables it.
 *
 * SCOPE (Ahmad, 2026-10-07): payments = Paymob, Kashier, FawryPay (+ COD and InstaPay, manual);
 * shipping = Bosta, ShipBlu, Mylerz, Aramex (+ manual delivery). Nothing else is added here; a
 * merchant who needs another provider is pointed at the support address instead.
 *
 * `verified` (PROVIDERS-2): a provider that has NOT completed a full flow against its real
 * sandbox is shown to merchants as "coming soon" and can never be enabled. It flips to true only
 * with the evidence named in `verification` (`scripts/provider-sandbox-check.mjs <code>` output).
 *
 * Every URL below is the provider's OWN documentation or dashboard (fetched 2026-10-07).
 * Nothing here is a secret.
 */

export type ProviderKind = 'payments' | 'shipping';
export type CredentialMode = 'sandbox' | 'live';
export const CREDENTIAL_MODES: readonly CredentialMode[] = ['sandbox', 'live'] as const;

export interface LocalizedText {
  en: string;
  ar: string;
}

/**
 * Where a decrypted field lands in the adapter's `ProviderCredentials` (apps/api): one of the
 * four named slots, or a path under `settings` (`settings.integrationIds.card`).
 */
export type CredentialBinding =
  | 'apiKey'
  | 'secretKey'
  | 'merchantId'
  | 'webhookSecret'
  | `settings.${string}`;

export interface CredentialFieldDef {
  /** Stable storage key inside the encrypted blob. Never renamed once shipped. */
  key: string;
  label: LocalizedText;
  /** One line under the input: what this value is. */
  help: LocalizedText;
  /** "Where do I find this?": the exact place in the provider's dashboard. */
  whereToFind: LocalizedText;
  /** Secret: write-only (shown as "saved ••••" + last 4), never returned to the browser. */
  secret: boolean;
  type: 'string' | 'integer';
  required: boolean;
  /** Regex source (no flags) the value must match, checked in the admin AND the API. */
  pattern?: string;
  maxLength?: number;
  bind: CredentialBinding;
}

export interface ProviderWebhookDef {
  /**
   * `per-request`: Ebda sends the store's webhook URL with every payment (nothing to paste).
   * `dashboard`: the merchant pastes the URL into the provider's dashboard (or sends it to the
   * provider's team).
   */
  delivery: 'per-request' | 'dashboard';
  /** How the delivery is authenticated, for the record (the adapter implements it). */
  signature: string;
  setupHelp: LocalizedText;
}

export interface ProviderVerification {
  /** ISO date of the sandbox run that proved create + webhook + refund, or null. */
  sandboxVerifiedAt: string | null;
  /** What is still unproven (shown to super admins). */
  note: string;
}

export interface ProviderCatalogEntry {
  code: string;
  kind: ProviderKind;
  name: LocalizedText;
  /** Monogram badge (no third-party logo files are vendored). */
  logo: { monogram: string; color: string };
  /** Manual methods have no API, no credentials and nothing to verify (COD, InstaPay, manual delivery). */
  manual: boolean;
  /** PROVIDERS-2: false = "coming soon", never selectable or enable-able by a merchant. */
  verified: boolean;
  verification: ProviderVerification;
  /** Customer-facing methods (payments) or service features (shipping). */
  capabilities: {
    methods: readonly string[];
    refunds: boolean;
    partialRefunds: boolean;
    webhooks: boolean;
  };
  /** The credential fields; the same shape is stored separately for sandbox and live. */
  fields: readonly CredentialFieldDef[];
  docs: {
    overview: string;
    credentials: string;
    /** The page in the provider's dashboard where the merchant copies the values. */
    dashboard?: string;
    /** Where a merchant signs up for a sandbox / test account. */
    sandboxSignup?: string;
  };
  webhook: ProviderWebhookDef | null;
}

const PAYMOB_DOCS = 'https://developers.paymob.com/paymob-docs';
const KASHIER_DOCS = 'https://developers.kashier.io';
const FAWRY_DOCS = 'https://developer.fawrystaging.com';

const integrationIdField = (
  key: string,
  method: LocalizedText,
  required = false
): CredentialFieldDef => ({
  key: `integrationId.${key}`,
  label: { en: `Integration ID: ${method.en}`, ar: `رقم التكامل: ${method.ar}` },
  help: {
    en: `The Paymob integration that accepts ${method.en}. Leave empty to not offer it.`,
    ar: `رقم تكامل باي موب الخاص بـ ${method.ar}. اتركه فاضي لو مش عايز تفعّله.`,
  },
  whereToFind: {
    en: 'Paymob Accept dashboard > Settings > Payment Integrations: the "Integration ID" column. Test and live integrations have different IDs (switch the mode at the top right).',
    ar: 'لوحة باي موب (Accept) > Settings > Payment Integrations: عمود "Integration ID". تكاملات التجربة أرقامها غير الحقيقية (غيّر الوضع من فوق على اليمين).',
  },
  secret: false,
  type: 'integer',
  required,
  pattern: '^[1-9][0-9]{0,9}$',
  bind: `settings.integrationIds.${key}`,
});

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  // ------------------------------------------------------------------ payments
  {
    code: 'paymob',
    kind: 'payments',
    name: { en: 'Paymob', ar: 'باي موب' },
    logo: { monogram: 'P', color: '#0B5FFF' },
    manual: false,
    verified: false,
    verification: {
      sandboxVerifiedAt: null,
      note: 'Built from the official Intention API, refund/void and HMAC pages; not yet run against a Paymob test account (scripts/provider-sandbox-check.mjs paymob).',
    },
    capabilities: {
      methods: ['card', 'wallet', 'valu', 'kiosk', 'applepay'],
      refunds: true,
      partialRefunds: true,
      webhooks: true,
    },
    fields: [
      {
        key: 'secretKey',
        label: { en: 'Secret key', ar: 'المفتاح السري (Secret key)' },
        help: {
          en: 'Authorises Ebda to create payments and refunds on your Paymob account.',
          ar: 'بيسمح لإبدأ تعمل عمليات دفع واسترداد على حساب باي موب بتاعك.',
        },
        whereToFind: {
          en: 'Paymob Accept dashboard > Settings > API Keys (under Developers) > View next to "Secret Key". Starts with sk_test_ in test mode and sk_live_ in live mode.',
          ar: 'لوحة باي موب (Accept) > Settings > API Keys (تحت Developers) > View جنب "Secret Key". بيبدأ بـ sk_test_ في وضع التجربة و sk_live_ في الوضع الحقيقي.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 300,
        bind: 'apiKey',
      },
      {
        key: 'publicKey',
        label: { en: 'Public key', ar: 'المفتاح العام (Public key)' },
        help: {
          en: 'Opens the Paymob checkout page for your customers. Not secret.',
          ar: 'بيفتح صفحة دفع باي موب لعملائك. مش سري.',
        },
        whereToFind: {
          en: 'Paymob Accept dashboard > Settings > API Keys > View next to "Public Key" (pk_test_... in test mode, pk_live_... in live mode).',
          ar: 'لوحة باي موب (Accept) > Settings > API Keys > View جنب "Public Key" (pk_test_... للتجربة و pk_live_... للحقيقي).',
        },
        secret: false,
        type: 'string',
        required: true,
        maxLength: 300,
        bind: 'settings.publicKey',
      },
      {
        key: 'apiKey',
        label: { en: 'API key', ar: 'مفتاح الـ API' },
        help: {
          en: 'Used by Test connection and by refunds (Paymob issues an auth token from it).',
          ar: 'بيُستخدم في اختبار الاتصال وفي الاسترداد (باي موب بيطلع منه توكن).',
        },
        whereToFind: {
          en: 'Paymob Accept dashboard > Settings > API Keys > View next to "API Key". It is the same key in test and live mode.',
          ar: 'لوحة باي موب (Accept) > Settings > API Keys > View جنب "API Key". نفس المفتاح في التجربة والحقيقي.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 1000,
        bind: 'secretKey',
      },
      {
        key: 'hmacSecret',
        label: { en: 'HMAC secret', ar: 'مفتاح الـ HMAC' },
        help: {
          en: 'Proves a payment notification really came from Paymob. Without it every notification is refused.',
          ar: 'بيثبت إن إشعار الدفع جاي فعلًا من باي موب. من غيره كل الإشعارات بتترفض.',
        },
        whereToFind: {
          en: 'Paymob Accept dashboard > Settings, next to your API keys ("HMAC"). Paymob\'s docs do not name the exact place: if you cannot see it, ask your Paymob account manager for the HMAC secret.',
          ar: 'لوحة باي موب (Accept) > Settings جنب مفاتيح الـ API ("HMAC"). مستندات باي موب مش محددة مكانه بالظبط: لو مش لاقيه، اطلبه من مدير حسابك في باي موب.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 300,
        bind: 'webhookSecret',
      },
      integrationIdField('card', { en: 'Cards', ar: 'البطاقات' }),
      integrationIdField('wallet', { en: 'Mobile wallets', ar: 'المحافظ الإلكترونية' }),
      integrationIdField('valu', { en: 'valU / installments (BNPL)', ar: 'فاليو / التقسيط' }),
      integrationIdField('kiosk', { en: 'Kiosk (Aman / Masary)', ar: 'الكشك (أمان / مصاري)' }),
      // Apple Pay has LIVE integration ids only (Paymob docs): leave it empty in sandbox.
      integrationIdField('applepay', {
        en: 'Apple Pay (live mode only)',
        ar: 'Apple Pay (الوضع الحقيقي بس)',
      }),
    ],
    docs: {
      overview: `${PAYMOB_DOCS}/getting-started/overview`,
      credentials: `${PAYMOB_DOCS}/developers/getting-integration-credentials`,
      dashboard: 'https://accept.paymob.com/',
    },
    webhook: {
      // Paymob honours a per-intention `notification_url` for CARD integrations only; wallets,
      // valU and kiosk call the Webhook URL saved on each integration. So the merchant pastes it.
      delivery: 'dashboard',
      signature:
        'HMAC-SHA512 (hex) over 20 callback fields in documented order, in the ?hmac= query parameter',
      setupHelp: {
        en: 'Paste this URL as the "Webhook URL" (transaction processed callback) of EVERY integration you entered above: Paymob Accept dashboard > Settings > Payment Integrations > the integration > Edit > Webhook URL > Save Changes.',
        ar: 'الزق الرابط ده في خانة "Webhook URL" لكل تكامل كتبت رقمه فوق: لوحة باي موب > Settings > Payment Integrations > التكامل > Edit > Webhook URL > Save Changes.',
      },
    },
  },
  {
    code: 'kashier',
    kind: 'payments',
    name: { en: 'Kashier', ar: 'كاشير' },
    logo: { monogram: 'K', color: '#00A19A' },
    manual: false,
    verified: false,
    verification: {
      sandboxVerifiedAt: null,
      note: 'Built from developers.kashier.io (llms-full.txt + openapi.yaml); not yet run against a Kashier test account (scripts/provider-sandbox-check.mjs kashier).',
    },
    capabilities: {
      methods: ['card', 'wallet', 'bnpl'],
      refunds: true,
      partialRefunds: true,
      webhooks: true,
    },
    fields: [
      {
        key: 'merchantId',
        label: { en: 'Merchant ID (MID)', ar: 'رقم التاجر (MID)' },
        help: {
          en: 'Your Kashier merchant ID, like MID-1234-567.',
          ar: 'رقم التاجر بتاعك في كاشير، شكله MID-1234-567.',
        },
        whereToFind: {
          en: 'Kashier dashboard: under your user name in the top bar.',
          ar: 'لوحة كاشير: تحت اسم المستخدم في الشريط اللي فوق.',
        },
        secret: false,
        type: 'string',
        required: true,
        pattern: '^MID-[0-9]+-[0-9]+$',
        maxLength: 40,
        bind: 'merchantId',
      },
      {
        key: 'paymentApiKey',
        label: { en: 'Payment API key', ar: 'مفتاح الدفع (Payment API key)' },
        help: {
          en: 'Creates payment sessions and verifies Kashier notifications.',
          ar: 'بيعمل جلسات الدفع وبيتأكد من إشعارات كاشير.',
        },
        whereToFind: {
          en: 'Kashier dashboard > Integrations > Payment API Keys. Test and live keys differ: switch "It\'s live data" for the live one.',
          ar: 'لوحة كاشير > Integrations > Payment API Keys. مفاتيح التجربة غير الحقيقية: فعّل "It\'s live data" علشان تاخد الحقيقي.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 300,
        bind: 'apiKey',
      },
      {
        key: 'secretKey',
        label: { en: 'Secret key', ar: 'المفتاح السري (Secret key)' },
        help: {
          en: 'Authorises status checks and refunds. The user who created it needs the refund permission.',
          ar: 'بيسمح بمتابعة الحالة والاسترداد. المستخدم اللي عمله لازم يكون عنده صلاحية الاسترداد.',
        },
        whereToFind: {
          en: 'Kashier dashboard > Integrations > Secret Keys (same test / live switch).',
          ar: 'لوحة كاشير > Integrations > Secret Keys (نفس مفتاح التجربة / الحقيقي).',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 500,
        bind: 'secretKey',
      },
    ],
    docs: {
      overview: `${KASHIER_DOCS}/`,
      credentials: `${KASHIER_DOCS}/docs/get-started/api-keys`,
      dashboard: 'https://merchant.kashier.io/en/dashboard/integration',
    },
    webhook: {
      delivery: 'per-request',
      signature:
        'HMAC-SHA256 (hex) of the sorted signatureKeys as k=v&k=v (values RFC 3986-encoded), header x-kashier-signature, keyed with the Payment API key',
      setupHelp: {
        en: 'Nothing to paste: Ebda sends this URL with every payment session ("serverWebhook").',
        ar: 'مش محتاج تلزق حاجة: إبدأ بيبعت الرابط ده مع كل جلسة دفع.',
      },
    },
  },
  {
    code: 'fawry',
    kind: 'payments',
    name: { en: 'FawryPay', ar: 'فوري باي' },
    logo: { monogram: 'F', color: '#F2B705' },
    manual: false,
    verified: false,
    verification: {
      sandboxVerifiedAt: null,
      note: 'Built from developer.fawrystaging.com; not yet run against FawryPay staging (scripts/provider-sandbox-check.mjs fawry). Status v2 answering 9938 for an unknown order is unconfirmed.',
    },
    capabilities: {
      methods: ['payatfawry', 'card'],
      refunds: true,
      partialRefunds: true,
      webhooks: true,
    },
    fields: [
      {
        key: 'merchantCode',
        label: { en: 'Merchant code', ar: 'كود التاجر (Merchant code)' },
        help: {
          en: 'Identifies your FawryPay account.',
          ar: 'بيعرّف حساب فوري باي بتاعك.',
        },
        whereToFind: {
          en: 'Sent by the FawryPay team in the account-setup email (staging and production codes differ).',
          ar: 'بيوصلك من فريق فوري باي في إيميل تفعيل الحساب (كود التجربة غير كود الحقيقي).',
        },
        secret: false,
        type: 'string',
        required: true,
        maxLength: 100,
        bind: 'merchantId',
      },
      {
        key: 'secureKey',
        label: { en: 'Secure key', ar: 'مفتاح الأمان (Secure key)' },
        help: {
          en: 'Signs every request to FawryPay and verifies its notifications.',
          ar: 'بيوقّع كل طلب لفوري باي وبيتأكد من إشعاراتها.',
        },
        whereToFind: {
          en: 'Sent by the FawryPay team with your merchant code. Ask FawryPay support if you do not have it.',
          ar: 'بيوصلك من فريق فوري باي مع كود التاجر. اطلبه من دعم فوري باي لو مش معاك.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 300,
        bind: 'apiKey',
      },
    ],
    docs: {
      overview: `${FAWRY_DOCS}/`,
      credentials: `${FAWRY_DOCS}/docs/get-started`,
      sandboxSignup: 'https://atfawry.fawrystaging.com/merchant/register',
    },
    webhook: {
      delivery: 'dashboard',
      signature:
        'SHA-256 of fawryRefNumber + merchantRefNumber + paymentAmount + orderAmount + orderStatus + paymentMethod + paymentRefrenceNumber + secureKey, in the body field messageSignature',
      setupHelp: {
        en: 'Send this URL to the FawryPay team as your "server notification" (callback) URL; FawryPay configures it on your account. Ebda also sends it with each order.',
        ar: 'ابعت الرابط ده لفريق فوري باي على إنه رابط الإشعارات (callback) بتاعك، وهما بيضبطوه على حسابك. وإبدأ كمان بيبعته مع كل طلب.',
      },
    },
  },
  {
    code: 'cod',
    kind: 'payments',
    name: { en: 'Cash on delivery', ar: 'الدفع عند الاستلام' },
    logo: { monogram: 'C', color: '#64748B' },
    manual: true,
    verified: true,
    verification: { sandboxVerifiedAt: null, note: 'Manual: no provider API.' },
    capabilities: { methods: ['cod'], refunds: false, partialRefunds: false, webhooks: false },
    fields: [],
    docs: { overview: '', credentials: '' },
    webhook: null,
  },
  {
    code: 'instapay',
    kind: 'payments',
    name: { en: 'InstaPay', ar: 'إنستاباي' },
    logo: { monogram: 'I', color: '#6B3FA0' },
    manual: true,
    verified: true,
    verification: {
      sandboxVerifiedAt: null,
      note: 'Manual transfer confirmed by the merchant: no provider API.',
    },
    capabilities: { methods: ['instapay'], refunds: false, partialRefunds: false, webhooks: false },
    fields: [],
    docs: { overview: '', credentials: '' },
    webhook: null,
  },
];

/** Codes of every payment provider in the catalog. */
export const PAYMENT_PROVIDER_CODES = PROVIDER_CATALOG.filter(p => p.kind === 'payments').map(
  p => p.code
);

export function getProviderEntry(code: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find(p => p.code === code);
}

export function providersOfKind(kind: ProviderKind): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter(p => p.kind === kind);
}

/** True when a merchant may enable this provider (PROVIDERS-2). */
export function isProviderSelectable(entry: ProviderCatalogEntry | undefined): boolean {
  return Boolean(entry && (entry.manual || entry.verified));
}

/** "Need another provider?": prefilled mail to support. */
export function providerRequestMailto(supportEmail: string, kind: ProviderKind): string {
  const subject =
    kind === 'payments'
      ? 'Ebda: request a payment provider / طلب شركة دفع'
      : 'Ebda: request a shipping provider / طلب شركة شحن';
  return `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}`;
}
