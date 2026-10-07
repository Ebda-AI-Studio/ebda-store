/**
 * Protected (brand / trademark) store names — separate from `RESERVED_SLUGS`.
 *
 * `RESERVED_SLUGS` are OUR service labels (`api`, `www`, …): they collide with
 * real hosts and are refused for everyone, always. THIS list is names a
 * self-serve visitor could squat to impersonate someone else — the platform
 * itself, payment brands, banks, telcos, marketplaces and well-known Egyptian
 * and global brands. A match is refused with `SLUG_PROTECTED` and a "contact
 * support to claim it" message; a `super_admin` may override (it is the
 * support-claim path: after verifying the claimant).
 *
 * Entries are plain brand tokens; the matcher normalises BOTH sides, so
 * `vodafone-cash`, `vodafonecash` and `v0dafone-cash2` are the same name.
 *
 * Maintenance: append lowercase tokens in any position. Keep the list to names
 * where impersonation is plausible; a generic dictionary word ("tap", "we",
 * "orange" as a fruit shop is the cost of listing the telco — support can
 * claim-override) is a false-positive tax on real merchants.
 */
export const PROTECTED_BRAND_NAMES: readonly string[] = [
  // Ebda / Ebda AI Studio (the platform and its operator); whisky11 stays reserved
  'ebda',
  'ebdaapp',
  'ebdaeg',
  'ebdaegypt',
  'ebda-support',
  'ebda-billing',
  'ebda-team',
  'ebdastudio',
  'ebda-studio',
  'ebda-ai-studio',
  'whisky11',
  'whisky-11',
  'whisky',
  'whiskyeleven',
  // Payments, wallets, fintech
  'paymob',
  'accept-paymob',
  'fawry',
  'fawrypay',
  'instapay',
  'vodafone-cash',
  'vodafonecash',
  'orange-cash',
  'orangecash',
  'etisalat-cash',
  'etisalatcash',
  'ecash',
  'meeza',
  'meezadigital',
  'valu',
  'sympl',
  'contact-financial',
  'halan',
  'tamara',
  'tabby',
  'paypal',
  'stripe',
  'visa',
  'mastercard',
  'amex',
  'applepay',
  'googlepay',
  'samsungpay',
  'westernunion',
  'moneygram',
  'payoneer',
  'binance',
  'bitcoin',
  // Banks and regulators (Egypt)
  'cbe',
  'centralbankofegypt',
  'nbe',
  'nationalbankofegypt',
  'banquemisr',
  'bank-misr',
  'bankmisr',
  'cib',
  'cibegypt',
  'qnb',
  'qnbalahli',
  'alexbank',
  'ahlybank',
  'hsbc',
  'nbk',
  'faisalbank',
  'adib',
  'aaib',
  'saib',
  'fra-egypt',
  'egyptpost',
  'egyptgov',
  'egypt-gov',
  // Telecom and utilities
  'vodafone',
  'orangeegypt',
  'etisalat',
  'telecomegypt',
  'te-data',
  'mobinil',
  'egyptair',
  // Marketplaces, delivery, tech platforms
  'amazon',
  'amazoneg',
  'noon',
  'jumia',
  'souq',
  'talabat',
  'elmenus',
  'mrsool',
  'instashop',
  'breadfast',
  'uber',
  'careem',
  'swvl',
  'aramex',
  'bosta',
  'mylerz',
  'dhl',
  'fedex',
  'shopify',
  'woocommerce',
  'wordpress',
  'cloudflare',
  'google',
  'gmail',
  'youtube',
  'facebook',
  'instagram',
  'whatsapp',
  'tiktok',
  'snapchat',
  'twitter',
  'linkedin',
  'telegram',
  'microsoft',
  'apple',
  'icloud',
  'netflix',
  'spotify',
  'openai',
  'chatgpt',
  'anthropic',
  // Retail and consumer brands, Egypt
  'carrefour',
  'spinneys',
  'hyperone',
  'btech',
  'raya',
  'rayashop',
  'elaraby',
  'juhayna',
  'edita',
  'cilantro',
  'americana',
  'cleopatra',
  'fayrouz',
  'domty',
  'lazah',
  'koshary-eltahrir',
  'abouelsid',
  'chefoo',
  'mcdonalds',
  'kfc',
  'hardees',
  'starbucks',
  'costacoffee',
  'cocacola',
  'pepsi',
  // Global brands
  'nike',
  'adidas',
  'puma',
  'zara',
  'defacto',
  'lcwaikiki',
  'ikea',
  'samsung',
  'huawei',
  'xiaomi',
  'sony',
  'lenovo',
  'dell',
  'gucci',
  'chanel',
  'dior',
  'prada',
  'louisvuitton',
  'hermes',
  'rolex',
  'cartier',
  'lacoste',
  'levis',
  'ralphlauren',
  'tommyhilfiger',
  'calvinklein',
  'newbalance',
  'underarmour',
  'oppo',
  'toyota',
  'mercedes',
  'bmw',
  'tesla',
];

/**
 * Words an impersonator bolts onto a brand (`paymob-support`, `officialfawry`,
 * `vodafonecashegypt`). A slug that is a brand plus one of these is refused;
 * a brand merely EMBEDDED in a longer real word (`pineapple`, `hmm`) is not.
 */
export const IMPERSONATION_WORDS: readonly string[] = [
  'support',
  'official',
  'help',
  'helpdesk',
  'care',
  'customercare',
  'service',
  'services',
  'team',
  'admin',
  'login',
  'signin',
  'secure',
  'security',
  'verify',
  'verification',
  'billing',
  'pay',
  'payment',
  'payments',
  'wallet',
  'cash',
  'money',
  'shop',
  'store',
  'online',
  'app',
  'eg',
  'egypt',
  'egy',
  'misr',
  'mena',
  'com',
  'net',
  'inc',
  'group',
  'global',
  'the',
  'my',
];

/** Single-character look-alikes. `1` is ambiguous (`i` vs `l`), so it yields two readings. */
const LEET: Record<string, string> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
};

/**
 * Every normalised reading of one fragment: lowercase, drop accents-free
 * punctuation (hyphens, dots, underscores), fold leetspeak, strip any digit
 * that is left. Three readings: digits simply stripped (`fawry24` -> `fawry`),
 * and the leet-folded forms with `1` read as `i` and as `l` (`1nstapay`,
 * `pay1pal`).
 */
function readings(fragment: string): string[] {
  const lower = fragment.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]/g, '').replace(/[0-9]/g, '');
  const leet = (one: 'i' | 'l') => {
    let out = '';
    for (const ch of lower) {
      if (ch === '1') out += one;
      else out += LEET[ch] ?? ch;
    }
    return out.replace(/[^a-z]/g, '');
  };
  const set = new Set<string>([stripped, leet('i'), leet('l')]);
  set.delete('');
  return [...set];
}

/**
 * Normalise a slug / brand to its comparable forms (see {@link readings}).
 * Exported for tests and for callers that want the matched form in a log line.
 */
export function normalizeSlugForMatch(raw: string): string[] {
  return readings(raw);
}

const collapse = (s: string) => s.replace(/(.)\1+/g, '$1');

/** Brands in plain-letter form: `whisky11` -> `whisky`, `vodafone-cash` -> `vodafonecash`. */
const brandForms = new Set<string>();
/**
 * Doubled-letter collapse (`paymmob`, `fawrry`) is applied to LONG brands only
 * (6+ letters): collapsing a short one (`dell` -> `del`, `noon` -> `non`)
 * would block ordinary words.
 */
const brandCollapsed = new Set<string>();
for (const b of PROTECTED_BRAND_NAMES) {
  const plain = b
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/[0-9]/g, '');
  if (!plain) continue;
  brandForms.add(plain);
  if (plain.length >= 6) brandCollapsed.add(collapse(plain));
}
const isBrandForm = (form: string) =>
  brandForms.has(form) || (form.length >= 5 && brandCollapsed.has(collapse(form)));
const genericForms = new Set<string>(IMPERSONATION_WORDS);

/** The protected brand form a slug collides with, or `null`. */
export function matchProtectedName(slug: string | null | undefined): string | null {
  if (typeof slug !== 'string') return null;
  const lower = slug.trim().toLowerCase();
  if (!lower) return null;

  const hit = (form: string): string | null => {
    if (isBrandForm(form)) return form;
    // brand + impersonation word, either order (`paymobsupport`, `officialfawry`).
    for (const g of genericForms) {
      if (form.length > g.length && form.startsWith(g) && isBrandForm(form.slice(g.length))) {
        return form.slice(g.length);
      }
      if (form.length > g.length && form.endsWith(g) && isBrandForm(form.slice(0, -g.length))) {
        return form.slice(0, -g.length);
      }
    }
    return null;
  };

  // Whole slug first (`vodafone-cash`, `v0dafone-cash2`, `ebdasupport`)…
  for (const r of readings(lower)) {
    const m = hit(r);
    if (m) return m;
  }
  // …then each hyphen-separated token on its own (`my-store-paymob`,
  // `ebda-support`) — a brand as one WORD of the slug is impersonation even
  // when the rest is unrelated. A brand buried inside a longer word is not.
  const tokens = lower.split(/[-_.]+/).filter(Boolean);
  if (tokens.length > 1) {
    for (const t of tokens) {
      for (const r of readings(t)) {
        if (isBrandForm(r)) return r;
      }
    }
    // Adjacent tokens form a multi-word brand (`vodafone` + `cash`).
    for (let i = 0; i < tokens.length - 1; i++) {
      for (const a of readings(tokens[i])) {
        for (const b of readings(tokens[i + 1])) {
          if (isBrandForm(a + b)) return a + b;
        }
      }
    }
  }
  return null;
}

/** True when `slug` collides with a protected brand / platform name (after normalisation). */
export function isProtectedSlug(slug: string | null | undefined): boolean {
  return matchProtectedName(slug) !== null;
}
