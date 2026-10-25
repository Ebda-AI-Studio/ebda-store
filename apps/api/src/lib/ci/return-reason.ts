/**
 * Return-reason normalisation (Customer Intelligence 1.1): what a carrier or merchant wrote when a COD
 * parcel failed or came back, mapped to the CLOSED code list. Unknown phrases map to `other` and keep
 * the (scrubbed) raw text; `other` above 20% of a carrier's returns raises an alert (the table is stale).
 *
 * The phrase tables are per carrier. Honest status: the carriers' real status strings are mostly NOT
 * in their public docs (docs/ebda/research/egypt-shipping-carriers.md marks them unverified), so each
 * table holds the phrases we expect plus a shared Arabic/English set, and the fixture test pins them.
 * First live returns per carrier must be checked against `other` rate before the table is trusted.
 */
export const RETURN_REASON_CODES = [
  'customer_refused',
  'customer_unreachable',
  'wrong_address',
  'address_incomplete',
  'customer_postponed',
  'price_dispute',
  'product_not_as_described',
  'damaged_in_transit',
  'courier_failed_attempts',
  'courier_lost',
  'duplicate_order',
  'fake_order',
  'other',
] as const;
export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export const RETURN_REASON_RAW_MAX = 200;

/** Arabic-Indic (٠-٩) and extended/Persian (۰-۹) digits -> ASCII, so a phone typed in Arabic digits is still a phone. */
export function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

const PHONE = /(?:\+|00)?\d[\d\s().-]{6,}\d/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;

/**
 * Free text from a carrier into the stream: phones, emails and links masked, whitespace folded, cut to
 * 200 chars. This is the ONLY free text CI keeps; a courier note can quote a customer's number.
 */
export function scrubFreeText(input: unknown, max = RETURN_REASON_RAW_MAX): string | null {
  if (typeof input !== 'string') return null;
  const s = asciiDigits(input)
    .replace(URL_RE, '[link]')
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
}

type Rule = [RegExp, ReturnReasonCode];

/** Order matters: the first match wins, so the specific phrases come before the generic ones. */
const SHARED: Rule[] = [
  [/fake|prank|وهمي|مش جاد/i, 'fake_order'],
  [/duplicate|ordered twice|مكرر|اتطلب مرتين/i, 'duplicate_order'],
  [/damag|broken|crush|تالف|مكسور|اتكسر/i, 'damaged_in_transit'],
  [
    /not as described|wrong item|different from|مش زي|غير مطابق|المنتج غلط/i,
    'product_not_as_described',
  ],
  [/price|expensive|too much|السعر|غالي/i, 'price_dispute'],
  [
    /wrong address|incorrect address|address not found|عنوان خطأ|عنوان غلط|مش لاقي العنوان|العنوان غير صحيح/i,
    'wrong_address',
  ],
  [
    /incomplete address|address (?:is )?(?:incomplete|missing)|missing address|عنوان ناقص|العنوان غير كامل/i,
    'address_incomplete',
  ],
  [
    /unreachable|no answer|not answering|phone (?:off|switched)|can'?t (?:be )?reach|لا يرد|مش بيرد|الهاتف مغلق|تليفون مقفول|لا يمكن الوصول/i,
    'customer_unreachable',
  ],
  [
    /postpone|reschedul|later date|ask(?:ed)? to deliver|طلب التأجيل|تأجيل|مؤجل|يطلب موعد|يوم تاني/i,
    'customer_postponed',
  ],
  [/refus|reject|declin|did not accept|not accept|رفض|رافض|مرفوض|لم يقبل/i, 'customer_refused'],
  [/lost|misplac|missing parcel|مفقود|ضايعة|ضاعت/i, 'courier_lost'],
  [
    /max(?:imum)? attempts|attempts (?:exceeded|exhausted)|failed attempts|عدد المحاولات|استنفاد المحاولات/i,
    'courier_failed_attempts',
  ],
];

/** Carrier-specific phrases placed BEFORE the shared set (a carrier's own wording beats the generic rule). */
const BY_CARRIER: Record<string, Rule[]> = {
  bosta: [
    [/consignee (?:refused|rejected)/i, 'customer_refused'],
    [/consignee (?:not available|unavailable|not answering)/i, 'customer_unreachable'],
  ],
  shipblu: [
    [/customer (?:cancelled|canceled)|cancelled by customer/i, 'customer_refused'],
    [/customer not (?:available|reachable)/i, 'customer_unreachable'],
  ],
  mylerz: [
    [/receiver (?:refused|rejected)/i, 'customer_refused'],
    [/receiver (?:not available|unreachable)/i, 'customer_unreachable'],
  ],
  aramex: [
    [/consignee (?:refused|rejected)|refused delivery/i, 'customer_refused'],
    [/consignee (?:not available|not in)|no one (?:available|at)/i, 'customer_unreachable'],
    [/incorrect consignee address|insufficient address/i, 'wrong_address'],
  ],
  manual: [],
};

export function mapReturnReason(
  carrier: string,
  raw: unknown
): { code: ReturnReasonCode; raw: string | null } {
  const text = scrubFreeText(raw);
  if (!text) return { code: 'other', raw: null };
  for (const [re, code] of [...(BY_CARRIER[carrier] ?? []), ...SHARED]) {
    if (re.test(text)) return { code, raw: text };
  }
  return { code: 'other', raw: text };
}
