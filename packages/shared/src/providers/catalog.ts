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
 * shipping = Bosta, ShipBlu, Mylerz, Aramex (+ manual delivery; ruling PROVIDERS-3). Nothing else
 * is added here; a merchant who needs another provider is pointed at the support address instead.
 *
 * SHIPPING entries: a field's `bind` is `settings.<key>` and means "lands under this key in the flat
 * credentials map the carrier adapter takes" (carriers have no apiKey/secretKey slots).
 *
 * `verified` (PROVIDERS-2, Ruling GW-VERIFIED-1): an API provider is `verified: true` ONLY with an evidence
 * reference in `verification.evidence` (the date of a recorded full run - create, pay, webhook, paid,
 * refund, refunded - AND a run id or link to its record: a `scripts/provider-sandbox-check.mjs` output
 * or a GATEWAY-LIVE-PROOF-RUNBOOK run). A bare boolean or a bare date is a claim, not evidence, and is
 * refused by `tests/unit/provider-connect.test.ts`. Unverified providers show merchants the
 * "not yet tried on a live account" note and need a passing Test connection before they are enabled.
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

/** The record of a full provider run (GW-VERIFIED-1). Both parts are required. */
interface ProviderEvidence {
  /** ISO date (YYYY-MM-DD) of the run that proved create + pay + webhook + refund end to end. */
  runAt: string;
  /** Where the run is recorded: a run id (`sandbox-check:<id>`) or a link to the run record. */
  runRef: string;
}

export interface ProviderVerification {
  /** The run that justifies `verified: true`, or null (unverified, or a manual method). */
  evidence: ProviderEvidence | null;
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
const GEIDEA_DOCS = 'https://docs.geidea.net';
const BOSTA_DOCS = 'https://docs.bosta.co';
const ARAMEX_DEVELOPERS = 'https://www.aramex.com/developers-solution-center/aramex-apis';
const SHIPBLU_DOCS = 'https://docs.shipblu.com';
const MYLERZ_SWAGGER = 'https://integration.mylerz.net/swagger/ui/index';

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
      evidence: null,
      note: 'Built from the official Intention API, refund/void and HMAC pages; not yet run against a Paymob test account (scripts/provider-sandbox-check.mjs paymob). Re-verified 2026-10-24 against developers.paymob.com (create-intention, unified-checkout-redirection, HMAC transaction callback incl. the worked example) and the official Postman collections (github.com/PaymobAccept/API-Postman-Collections): fixed billing_data.country (EGY), expiration cap (3110400 s), items sum rule, 50-char name cap, refund-callback detection via is_refund/is_void. UNCONFIRMED (docs silent or conflicting): transaction-inquiry auth (Postman: Bearer header + body order_id; older docs: auth_token in body, both are sent), what inquiry answers for an unknown order, whether items[].amount is per unit or per line, how a null HMAC field is stringified, the source_data.type of BNPL/installment (docs: not refundable), the exact void cut-off, callback retry policy and rate limits.',
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
          en: 'Authorises Ebda Store to create payments and refunds on your Paymob account.',
          ar: 'بيسمح لابدأ ستور تعمل عمليات دفع واسترداد على حساب باي موب بتاعك.',
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
    // GW-VERIFIED-1: the 2026-10-08 run below has no run record in the repo, so it is a claim, not evidence. Back to
    // unverified until a recorded run (GATEWAY-LIVE-PROOF-RUNBOOK) fills `evidence`.
    verified: false,
    verification: {
      evidence: null,
      note: 'UNVERIFIED (GW-VERIFIED-1, 2026-11-17): reported as run 2026-10-08 against a real Kashier test account, but no run record exists, so it does not count. Reported then: test connection, guest payment session, paid status, partial + full refund, and a real signed webhook delivery (tampered body rejected). Order-search status does not report refunds; refund state comes from the refund response and the webhook. Re-read 2026-10-24 against developers.kashier.io (payment-sessions, refunds, webhooks guide + payloads, api-keys, rate-limits, openapi.yaml): no discrepancy, nothing changed; the docs signature example still reproduces the documented HMAC. UNCONFIRMED: the allowedMethods token for BNPL (docs only show card,wallet), whether a webhook data.status can be INITIATED/UNKNOWN/EXPIRED/CANCEL/REVOKED (payloads page says SUCCESS|FAILURE|PENDING; the OpenAPI enum is wider).',
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
        en: 'Nothing to paste: Ebda Store sends this URL with every payment session ("serverWebhook").',
        ar: 'مش محتاج تلزق حاجة: ابدأ ستور بيبعت الرابط ده مع كل جلسة دفع.',
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
      evidence: null,
      note: 'Built from developer.fawrystaging.com; not yet run against FawryPay staging (scripts/provider-sandbox-check.mjs fawry). Re-verified 2026-10-24 against the charge (PayAtFawry), hosted checkout link, refund, cancel, status v2 and server notification v2 pages: endpoints, hosts, signature formulas and field names match; nothing changed. Status v2 answering 9938 for an unknown order is STILL unconfirmed: the status v2 page documents only the 9946 error sample (9938 is listed on the charge, refund and cancel pages). Also UNCONFIRMED: the production host of status v2, whether paymentAmount includes fawryFees (the status v2 sample shows paymentAmount 152.00 beside orderAmount 150.00 and fawryFees 2.00, so the paid-amount check against the order total may differ by the fee), the charge page types merchantRefNum as Integer while the hosted page says String, duplicate merchantRefNum behaviour, rate limits.',
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
        en: 'Send this URL to the FawryPay team as your "server notification" (callback) URL; FawryPay configures it on your account. Ebda Store also sends it with each order.',
        ar: 'ابعت الرابط ده لفريق فوري باي على إنه رابط الإشعارات (callback) بتاعك، وهما بيضبطوه على حسابك. وابدأ ستور كمان بيبعته مع كل طلب.',
      },
    },
  },
  {
    code: 'geidea',
    kind: 'payments',
    name: { en: 'Geidea', ar: 'جيديا' },
    logo: { monogram: 'G', color: '#E4002B' },
    manual: false,
    verified: false,
    verification: {
      evidence: null,
      note: 'CREATION ONLY (PLANS-ALL-1). Built from docs.geidea.net/docs/geidea-checkout-v2 (read 2026-10-26): POST /payment-intent/api/v2/direct/session on api.merchant.geidea.net, Basic auth publicKey:apiPassword, base64(HMAC-SHA256(apiPassword, publicKey+amount(2dp)+currency+merchantReferenceId+timestamp)), responseCode 000 + session.id. NOT documented publicly, so NOT implemented and fail-closed: the server callback payload and its signature (every Geidea webhook is REFUSED until a real merchant or Geidea support confirms the format), order retrieval, refunds/voids, the Egypt hosted-page address (needs GEIDEA_HPP_BASE_URL, else createPayment fails closed), a harmless credential check (no Test connection call: the connection is unverified), the timestamp time zone (UTC assumed), a separate sandbox host (same host assumed). A Geidea payment can be created but is not auto-confirmed by Ebda Store yet.',
    },
    capabilities: {
      methods: ['card'],
      refunds: false,
      partialRefunds: false,
      webhooks: false,
    },
    fields: [
      {
        key: 'merchantPublicKey',
        label: { en: 'Merchant public key', ar: 'المفتاح العام للتاجر (Merchant public key)' },
        help: {
          en: 'Identifies your Geidea merchant account (the Basic-auth user name).',
          ar: 'بيعرّف حساب جيديا بتاعك (اسم المستخدم في التوثيق).',
        },
        whereToFind: {
          en: 'Geidea merchant dashboard > Settings > API credentials (test and live differ). Ask Geidea support if you cannot see it.',
          ar: 'لوحة جيديا للتاجر > Settings > API credentials (مفاتيح التجربة غير الحقيقية). اسأل دعم جيديا لو مش ظاهرلك.',
        },
        secret: false,
        type: 'string',
        required: true,
        maxLength: 200,
        bind: 'merchantId',
      },
      {
        key: 'apiPassword',
        label: { en: 'API password', ar: 'كلمة مرور الـ API (API password)' },
        help: {
          en: 'Signs every session request to Geidea. Keep it private.',
          ar: 'بتوقّع كل طلب جلسة لجيديا. خليها سرية.',
        },
        whereToFind: {
          en: 'Geidea merchant dashboard > Settings > API credentials, next to the public key.',
          ar: 'لوحة جيديا للتاجر > Settings > API credentials، جنب المفتاح العام.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 300,
        bind: 'apiKey',
      },
    ],
    docs: {
      overview: `${GEIDEA_DOCS}/`,
      credentials: `${GEIDEA_DOCS}/docs/geidea-checkout-v2`,
    },
    webhook: null,
  },
  {
    code: 'cod',
    kind: 'payments',
    name: { en: 'Cash on delivery', ar: 'الدفع عند الاستلام' },
    logo: { monogram: 'C', color: '#64748B' },
    manual: true,
    verified: true,
    verification: { evidence: null, note: 'Manual: no provider API.' },
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
      evidence: null,
      note: 'Manual transfer confirmed by the merchant: no provider API.',
    },
    capabilities: { methods: ['instapay'], refunds: false, partialRefunds: false, webhooks: false },
    fields: [],
    docs: { overview: '', credentials: '' },
    webhook: null,
  },

  // ------------------------------------------------------------------ shipping
  {
    code: 'bosta',
    kind: 'shipping',
    name: { en: 'Bosta', ar: 'بوسطة' },
    logo: { monogram: 'B', color: '#E3262B' },
    manual: false,
    verified: false,
    verification: {
      evidence: null,
      note: 'Built from the official OpenAPI (docs.bosta.co/api/api.yaml) and the how-to pages; not yet run against a Bosta test account (scripts/provider-sandbox-check.mjs bosta). Re-read 2026-10-24 against api.yaml and docs.bosta.co/docs/how-to/{get-delivery-status-via-webhook,create-your-first-delivery,get-your-api-key}: auth, endpoints, create body, 30,000 EGP COD cap, webhook payload and the 23-state table all match the adapter. Still unconfirmed (the docs are silent): decimal COD (the schema type is number, every example is an integer), duplicate-reference error, webhook retries, which delivery states allow terminate, and stg-app.bosta.co (named only by Bosta’s SDK README).',
    },
    capabilities: {
      methods: ['cod', 'label', 'quote', 'pickup', 'cancel', 'tracking-webhook'],
      refunds: false,
      partialRefunds: false,
      webhooks: true,
    },
    fields: [
      {
        key: 'apiKey',
        label: { en: 'API key', ar: 'مفتاح الـ API' },
        help: {
          en: 'Lets Ebda Store create deliveries, print labels and read tracking on your Bosta account. Give it Read/Write access, or Full access if you want Ebda Store to cancel deliveries.',
          ar: 'بيسمح لابدأ ستور تعمل شحنات وتطبع بوالص وتتابع التتبع على حسابك في بوسطة. اديله صلاحية Read/Write، أو Full لو عايز ابدأ ستور تلغي الشحنات.',
        },
        whereToFind: {
          en: 'Bosta dashboard > Settings > API Integration > Request OTP > Create API key. Bosta shows the key once: copy it straight away.',
          ar: 'لوحة بوسطة > Settings > API Integration > Request OTP > Create API key. بوسطة بتعرض المفتاح مرة واحدة بس: انسخه فورًا.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 300,
        bind: 'settings.apiKey',
      },
      {
        key: 'businessLocationId',
        label: { en: 'Pickup location ID (optional)', ar: 'رقم موقع الاستلام (اختياري)' },
        help: {
          en: 'The Bosta pickup location parcels are collected from. Leave empty to use your default location.',
          ar: 'موقع الاستلام في بوسطة اللي الشحنات بتتسحب منه. سيبه فاضي علشان يستخدم موقعك الافتراضي.',
        },
        whereToFind: {
          en: 'Bosta dashboard > Settings > Pickup locations (the location ID). Test connection also lists the location IDs Bosta has for you.',
          ar: 'لوحة بوسطة > Settings > Pickup locations (رقم الموقع). اختبار الاتصال كمان بيعرض لك أرقام المواقع المسجلة.',
        },
        secret: false,
        type: 'string',
        required: false,
        pattern: '^[A-Za-z0-9_-]{3,40}$',
        maxLength: 40,
        bind: 'settings.businessLocationId',
      },
    ],
    docs: {
      overview: `${BOSTA_DOCS}/`,
      credentials: `${BOSTA_DOCS}/docs/how-to/get-your-api-key`,
      dashboard: 'https://business.bosta.co/',
    },
    webhook: {
      // Bosta takes a per-delivery webhookUrl + webhookCustomHeaders on create: nothing to paste.
      delivery: 'per-request',
      signature:
        'No HMAC (Bosta signs nothing). Ebda Store sends a per-store secret in the callback URL path AND a derived secret in a custom header (webhookCustomHeaders) on every delivery; both are required, constant-time compared',
      setupHelp: {
        en: 'Nothing to paste: Ebda Store gives Bosta the callback URL and a secret header with every delivery. Bosta calls it from 34.89.199.241 and 35.246.223.19.',
        ar: 'مش محتاج تلزق حاجة: ابدأ ستور بيدي بوسطة رابط الإشعارات وهيدر سري مع كل شحنة. بوسطة بتتصل من 34.89.199.241 و 35.246.223.19.',
      },
    },
  },
  {
    code: 'shipblu',
    kind: 'shipping',
    name: { en: 'ShipBlu', ar: 'شيب بلو' },
    logo: { monogram: 'S', color: '#1D4ED8' },
    manual: false,
    verified: false,
    verification: {
      evidence: null,
      note: 'Built from docs.shipblu.com + the official OpenAPI (api.shipblu.com/docs/?format=openapi); no ShipBlu staging key yet (scripts/provider-sandbox-check.mjs shipblu). Re-read 2026-10-24 (docs.shipblu.com/{quick-start,tutorial,api-reference}, the OpenAPI, and the official Postman collection docs.shipblu.com/assets/js/ShipBluAPI.json): auth, endpoints, the 32-status enum and the create body match the adapter; the Postman create example omits address.what3words, so not sending it is consistent with the docs. Still unconfirmed (the docs are silent): cancel (no endpoint), webhooks (none documented), COD unit of cash_amount (example 100, unit unstated), duplicate-reference behaviour.',
    },
    capabilities: {
      methods: ['cod', 'label', 'quote', 'pickup'],
      refunds: false,
      partialRefunds: false,
      webhooks: false,
    },
    fields: [
      {
        key: 'apiKey',
        label: { en: 'API key', ar: 'مفتاح الـ API' },
        help: {
          en: 'Lets Ebda Store book parcels, print labels and read tracking on your ShipBlu account.',
          ar: 'بيسمح لابدأ ستور تحجز الشحنات وتطبع البوالص وتتابع التتبع على حسابك في شيب بلو.',
        },
        whereToFind: {
          en: 'ShipBlu merchant dashboard (shipblu.com) > Integrations tab > the (+) button at the top right. The sandbox key is separate: email tech@shipblu.com with your business account name to get a staging account.',
          ar: 'لوحة تاجر شيب بلو (shipblu.com) > تبويب Integrations > زرار (+) فوق على اليمين. مفتاح التجربة منفصل: ابعت إيميل لـ tech@shipblu.com باسم حسابك علشان يفتحولك حساب تجريبي.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 300,
        bind: 'settings.apiKey',
      },
    ],
    docs: {
      overview: `${SHIPBLU_DOCS}/`,
      credentials: `${SHIPBLU_DOCS}/quick-start`,
      dashboard: 'https://shipblu.com/',
    },
    webhook: null,
  },
  {
    code: 'mylerz',
    kind: 'shipping',
    name: { en: 'Mylerz', ar: 'ميليرز' },
    logo: { monogram: 'M', color: '#E11D48' },
    manual: false,
    verified: false,
    verification: {
      evidence: null,
      note: 'Built from the official Swagger (integration.mylerz.net/swagger/docs/v1). Mylerz publishes NO sandbox: sandbox mode needs a staging host from Mylerz (MYLERZ_BASE_URL outside production), so a live run needs a real merchant account. Re-read 2026-10-24: every endpoint and DTO the adapter uses still matches the Swagger (no other official Mylerz doc is reachable: mylerz.net/developers is a script-only page). Still unconfirmed (the Swagger carries no descriptions or examples): status table, COD unit (OrderDTO.COD_Value is typed string, the other COD fields are double), duplicate-reference behaviour, webhook payload (POST /api/Merchant registration DTO only).',
    },
    capabilities: {
      methods: ['cod', 'label', 'quote', 'pickup', 'cancel'],
      refunds: false,
      partialRefunds: false,
      webhooks: false,
    },
    fields: [
      {
        key: 'username',
        label: { en: 'Username', ar: 'اسم المستخدم' },
        help: {
          en: 'The login Mylerz gave your business for the integration API.',
          ar: 'اسم الدخول اللي ميليرز إدّاه لشركتك علشان الربط البرمجي.',
        },
        whereToFind: {
          en: 'Issued by your Mylerz account manager together with the password (the same login as the Mylerz merchant portal). Ask Mylerz support if you do not have it.',
          ar: 'بيوصلك من مدير حسابك في ميليرز مع كلمة السر (نفس دخول بوابة التاجر). اطلبه من دعم ميليرز لو مش معاك.',
        },
        secret: false,
        type: 'string',
        required: true,
        maxLength: 200,
        bind: 'settings.username',
      },
      {
        key: 'password',
        label: { en: 'Password', ar: 'كلمة السر' },
        help: {
          en: 'Used only to ask Mylerz for an access token. Never shown again after saving.',
          ar: 'بتتستخدم بس علشان نطلب توكن من ميليرز. مش بتظهر تاني بعد الحفظ.',
        },
        whereToFind: {
          en: 'Issued by your Mylerz account manager with the username.',
          ar: 'بيوصلك من مدير حسابك في ميليرز مع اسم المستخدم.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 200,
        bind: 'settings.password',
      },
      {
        key: 'warehouseName',
        label: { en: 'Pickup warehouse name', ar: 'اسم مخزن الاستلام' },
        help: {
          en: 'The warehouse registered at Mylerz that parcels are collected from. Must match exactly.',
          ar: 'اسم المخزن المسجل عند ميليرز اللي الشحنات بتتسحب منه. لازم يطابق بالظبط.',
        },
        whereToFind: {
          en: 'Mylerz merchant portal > Warehouses (the "Name" column). Test connection lists the names Mylerz has for you.',
          ar: 'بوابة تاجر ميليرز > Warehouses (عمود "Name"). اختبار الاتصال بيجيب لك الأسماء المسجلة عند ميليرز.',
        },
        secret: false,
        type: 'string',
        required: true,
        maxLength: 200,
        bind: 'settings.warehouseName',
      },
    ],
    docs: {
      overview: MYLERZ_SWAGGER,
      credentials: MYLERZ_SWAGGER,
      dashboard: 'https://mylerz.net/login',
    },
    webhook: null,
  },
  {
    code: 'aramex',
    kind: 'shipping',
    name: { en: 'Aramex', ar: 'أرامكس' },
    logo: { monogram: 'A', color: '#D40511' },
    manual: false,
    verified: false,
    verification: {
      evidence: null,
      note: 'Built from the four public WSDLs on ws.aramex.net (SOAP element order from the schema). Re-verified 2026-10-24 against the WSDLs (51 request types, no drift) and Aramex’s official Shipping Services API Manual (aramex.com/docs/default-source/resourses/resourcesdata/shipping-services-api-manual.pdf; 403 to plain HTTP clients, readable in a browser): Source 24, units KG/CM, PaymentType P, service code CODS, ReportID 9201 + URL, EGP as a valid currency code, test host ws.dev.aramex.net, no shipment-cancel operation (pickups only) and the Appendix F error codes are documented; pickup Status and volume were corrected to the manual. Still UNVERIFIED (scripts/provider-sandbox-check.mjs aramex): domestic-Egypt product types (Appendix A lists only EXP types), the tracking UpdateCode table (in no file we hold), EGP COD enablement on the account. Also checked against Ahmad-supplied official files (Shipments Tracking WSDL, createShipmentsPHP.txt sample): tracking request/response shape matches, duplicate bookings are now guarded by ForeignHAWB (manual Table 18, ERR30), unit case is not significant (sample uses cm/Kg); no supplied file lists the tracking UpdateCode table or any domestic product type.',
    },
    capabilities: {
      methods: ['cod', 'label', 'quote', 'pickup'],
      refunds: false,
      partialRefunds: false,
      webhooks: false,
    },
    fields: [
      {
        key: 'username',
        label: { en: 'Username (email)', ar: 'اسم المستخدم (الإيميل)' },
        help: {
          en: 'The login of your Aramex account used for the shipping API.',
          ar: 'اسم دخول حساب أرامكس بتاعك اللي بيُستخدم للـ API.',
        },
        whereToFind: {
          en: 'Provided by Aramex when your shipping API access is set up (the same email as your Aramex account). Ask your Aramex account manager.',
          ar: 'بيوصلك من أرامكس لما بيتفعل لك الـ API (نفس إيميل حسابك). اسأل مدير حسابك في أرامكس.',
        },
        secret: false,
        type: 'string',
        required: true,
        maxLength: 200,
        bind: 'settings.username',
      },
      {
        key: 'password',
        label: { en: 'Password', ar: 'كلمة السر' },
        help: {
          en: 'The password for that login. Never shown again after saving.',
          ar: 'كلمة سر نفس الدخول. مش بتظهر تاني بعد الحفظ.',
        },
        whereToFind: {
          en: 'Provided by Aramex with the username.',
          ar: 'بتوصلك من أرامكس مع اسم المستخدم.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 200,
        bind: 'settings.password',
      },
      {
        key: 'accountNumber',
        label: { en: 'Account number', ar: 'رقم الحساب' },
        help: { en: 'Your Aramex account number.', ar: 'رقم حسابك في أرامكس.' },
        whereToFind: {
          en: 'Provided by Aramex with your API access, and printed on your Aramex invoices.',
          ar: 'بتوصلك من أرامكس مع تفعيل الـ API، ومكتوبة في فواتير أرامكس.',
        },
        secret: false,
        type: 'string',
        required: true,
        pattern: '^[0-9]{3,12}$',
        maxLength: 12,
        bind: 'settings.accountNumber',
      },
      {
        key: 'accountPin',
        label: { en: 'Account PIN', ar: 'الرقم السري للحساب (PIN)' },
        help: {
          en: 'The PIN that goes with the account number.',
          ar: 'الـ PIN المرتبط برقم الحساب.',
        },
        whereToFind: {
          en: 'Provided by Aramex with your account number.',
          ar: 'بيوصلك من أرامكس مع رقم الحساب.',
        },
        secret: true,
        type: 'string',
        required: true,
        maxLength: 50,
        bind: 'settings.accountPin',
      },
      {
        key: 'accountEntity',
        label: { en: 'Account entity', ar: 'كود الفرع (Entity)' },
        help: {
          en: 'The 3-letter code of the Aramex office your account belongs to (for example CAI for Cairo).',
          ar: 'كود من 3 حروف لفرع أرامكس اللي حسابك تابع له (مثلًا CAI للقاهرة).',
        },
        whereToFind: {
          en: 'Provided by Aramex with your account number. Ask your account manager if you do not know it.',
          ar: 'بيوصلك من أرامكس مع رقم الحساب. اسأل مدير حسابك لو مش عارفه.',
        },
        secret: false,
        type: 'string',
        required: true,
        pattern: '^[A-Za-z]{3}$',
        maxLength: 3,
        bind: 'settings.accountEntity',
      },
      {
        key: 'accountCountryCode',
        label: { en: 'Account country code', ar: 'كود دولة الحساب' },
        help: { en: 'EG for an Egyptian account.', ar: 'EG لحساب مصري.' },
        whereToFind: {
          en: 'Provided by Aramex with your account number (EG for Egypt).',
          ar: 'بيوصلك من أرامكس مع رقم الحساب (EG لمصر).',
        },
        secret: false,
        type: 'string',
        required: true,
        pattern: '^[A-Za-z]{2}$',
        maxLength: 2,
        bind: 'settings.accountCountryCode',
      },
    ],
    docs: {
      overview: ARAMEX_DEVELOPERS,
      credentials: ARAMEX_DEVELOPERS,
      dashboard: 'https://www.aramex.com/eg/en',
    },
    webhook: null,
  },
  {
    code: 'manual',
    kind: 'shipping',
    name: { en: 'Manual delivery', ar: 'توصيل يدوي' },
    logo: { monogram: 'D', color: '#64748B' },
    manual: true,
    verified: true,
    verification: { evidence: null, note: 'Manual: no carrier API.' },
    capabilities: { methods: ['cod'], refunds: false, partialRefunds: false, webhooks: false },
    fields: [],
    docs: { overview: '', credentials: '' },
    webhook: null,
  },
];

/** Codes of every payment provider in the catalog. */
export const PAYMENT_PROVIDER_CODES = PROVIDER_CATALOG.filter(p => p.kind === 'payments').map(
  p => p.code
);

/** Codes of every shipping carrier in the catalog (manual delivery included). */
export const SHIPPING_PROVIDER_CODES = PROVIDER_CATALOG.filter(p => p.kind === 'shipping').map(
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

/**
 * PROVIDERS-ACTIVATION: a provider a merchant can ask Ebda to switch on. Every API provider the
 * catalog lists that is not verified yet; the merchant saves and tests their own credentials
 * first, Ebda activates it for that store after its own test passes. Manual methods need none.
 */
export function isActivationRequestable(entry: ProviderCatalogEntry | undefined): boolean {
  return Boolean(entry && !entry.manual && !entry.verified);
}

/** Hours Ebda tells a merchant activation takes (the marketing site and the admin say the same). */
export const ACTIVATION_HOURS = 5;

/** "Need another provider?": prefilled mail to support. */
export function providerRequestMailto(supportEmail: string, kind: ProviderKind): string {
  const subject =
    kind === 'payments'
      ? 'Ebda Store: request a payment provider / طلب شركة دفع'
      : 'Ebda Store: request a shipping provider / طلب شركة شحن';
  return `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}`;
}
