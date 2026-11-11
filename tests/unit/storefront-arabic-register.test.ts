/**
 * Ruling FU46-Y02a (Ahmad 2026-10-16, supersedes FU46-Y02): a FULL SENTENCE the storefront
 * generates is Egyptian Arabic ("طلبك اتسجل", "يوصلك بين …", "سلتك فاضية"); a short button or
 * label stays a neutral form that reads right in both registers ("أرسل الإيصال", "موعد الوصول").
 * Ruling FU46-Y02b (coordinator 2026-10-16): the ONLY exception is legal text — the privacy and
 * terms pages, the returns-policy body and the cookie consent text stay formal (Ahmad can
 * override).
 *
 * Locks, so the register cannot drift back:
 *  1. MSA-only sentence markers (words with no Egyptian reading: "هذا", "لم", "يرجى", "سوف",
 *     "يجب", "كيف", "فارغة", the MSA dual "قطعتان"...) are banned in every Arabic string literal
 *     in `apps/web/src` + `packages/ui/src` (`\u06xx` escapes decoded) and in the shopper
 *     `messageAr` answers of the API. Legal text is exempt only where named: whole files in
 *     LEGAL_FILES, or the lines between `legal-register:start` / `legal-register:end` comments in
 *     a file listed in LEGAL_REGION_FILES. A region marker anywhere else fails the gate.
 *  2. The Egyptian sentence set Ahmad asked for is pinned verbatim (EGYPTIAN), so a sweep that
 *     "standardises" them turns this red even if it only uses words the marker list misses.
 *  3. The neutral button/label forms are pinned too (NEUTRAL), so the reverse drift is caught.
 *
 * NOT in scope: `components/landing/` (Ebda's own marketing landing), the admin, help and merchant
 * docs (merchant voice), and anything a merchant types (data, never in code).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');

/** Words with no Egyptian-colloquial reading. A whole-word match, so they cannot fire inside a word. */
export const MSA_ONLY = [
  'هذا',
  'هذه',
  'ذلك',
  'تلك',
  'لم',
  'لن',
  'سوف',
  'حالياً',
  'حاليًا',
  'حاليا',
  'يرجى',
  'نرجو',
  'الرجاء',
  'جارٍ',
  'جاري',
  'يوجد',
  'توجد',
  'لقد',
  'الذي',
  'التي',
  'الذين',
  'سنرد',
  'سيراجع',
  'ستظهر',
  'سيظهر',
  'سيتم',
  'سنقوم',
  'يصلك',
  'أولاً',
  'قطعتان',
  'يومان',
  'نتيجتان',
  'يمكنك',
  'بإمكانك',
  'لديك',
  'لدينا',
  'لديه',
  'إذا',
  'يجب',
  'ليس',
  'ليست',
  'كيف',
  'لماذا',
  'ماذا',
  'أين',
  'متى',
  'هل',
  'فقط',
  'فارغة',
  'فارغ',
  'عذراً',
  'عذرًا',
  'نأسف',
  'قم',
  'كن',
  'أنت',
  'مرة أخرى',
  'تم',
  'تمت',
  'تعذر',
  'تعذّر',
  'أدناه',
  'بنجاح',
  'الخاص بك',
  'الخاصة بك',
];
const AR = '\\u0621-\\u065F\\u0670\\u0640';
const WORD = new RegExp(`(?:^|[^${AR}])(${MSA_ONLY.join('|')})(?=$|[^${AR}])`, 'g');
/**
 * The Egyptian copy style guide's mechanical half (quality-bar.md § 2, Y-02): "إنت" with hamza
 * (never "انت" / "وانت"), joined negation ("منفعش", "متبعتش", never "ما نفعش"), no "حضرتك"
 * (masculine-singular address throughout), "عشان" (never "علشان").
 */
export const STYLE: Array<[string, RegExp]> = [
  ['write إنت with hamza', new RegExp(`(?:^|[^${AR}])(و?انت)(?=$|[^${AR}])`, 'g')],
  [
    'join the negation (مـ…ش, not ما …ش)',
    new RegExp(`(?:^|[^${AR}])(ما [${AR}]+ش)(?=$|[^${AR}])`, 'g'),
  ],
  [
    'join the negation (متقلقش, not ماتقلقش / مافيش: م + verb + ش)',
    new RegExp(`(?:^|[^${AR}])(و?ما(?:[تينأ][${AR}]+|في[${AR}]*)ش)(?=$|[^${AR}])`, 'g'),
  ],
  ['no حضرتك: masculine-singular address', new RegExp(`(?:^|[^${AR}])(حضرتك)(?=$|[^${AR}])`, 'g')],
  ['عشان, not علشان', new RegExp(`(?:^|[^${AR}])(علشان)(?=$|[^${AR}])`, 'g')],
];

/** Whole files that are legal text (Ruling FU46-Y02b): formal register allowed. */
const LEGAL_FILES: Record<string, string> = {
  'apps/web/src/app/privacy/PrivacyClient.tsx': 'privacy policy',
  'apps/web/src/app/terms/TermsClient.tsx': 'terms of service',
  'apps/web/src/components/CookieConsentBanner.tsx': 'cookie consent notice',
  'apps/web/src/components/CookiePreferencesModal.tsx': 'cookie preferences (consent text)',
};
/** Files whose legal part is fenced by `legal-register:start` / `legal-register:end` comments. */
const LEGAL_REGION_FILES: Record<string, string> = {
  'apps/web/src/app/returns/ReturnsClient.tsx': 'the returns-policy body (eligibility, refunds)',
  'apps/web/src/lib/return-policy-text.ts': 'the returns-policy and terms return sentences',
};
const REGION_START = /legal-register:start/;
const REGION_END = /legal-register:end/;

/** Ahmad's Egyptian sentences (2026-10-16), pinned in the file that renders them. */
const EGYPTIAN: Array<[string, string]> = [
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'طلبك اتسجل، الدفع عند الاستلام'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'طلبك اتسجل، في انتظار الدفع'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'اتدفع، طلبك اتأكد'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'بنطبع فاتورتك…'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'الدفع متمش'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'عندك سؤال؟ كلّم المتجر على واتساب'],
  ['apps/web/src/components/commerce/DeliveryChip.tsx', 'يوصلك بين'],
  ['apps/web/src/components/commerce/DeliveryChip.tsx', 'بيتجهزلك مخصوص في'],
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', 'صاحب المتجر هيراجع التحويل'],
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', 'الإيصال اتبعت.'],
  ['apps/web/src/app/contact/ContactClient.tsx', 'هنرد عليك في أقرب وقت.'],
  ['apps/web/src/components/UnknownHostNotFound.tsx', 'المتجر ده مش موجود أو لسه مفتحش'],
  ['apps/web/src/components/demo/DemoCheckoutNotice.tsx', 'ده متجر تجريبي — الطلبات مقفولة'],
  ['apps/web/src/templates/dahab/CartDrawer.tsx', 'سلتك فاضية'],
  ['apps/web/src/lib/return-policy-text.ts', 'بنقبل الإرجاع خلال'],
  [
    'apps/web/src/app/checkout/success/SuccessClient.tsx',
    'طلبك اتسجل. جهّز المبلغ لما الطلب يوصلك.',
  ],
  ['packages/shared/src/utils/plural.ts', "two: 'قطعتين'"],
  ['apps/web/src/lib/plural.ts', "two: 'يومين'"],
  ['apps/api/src/routes/public.routes.ts', 'ده متجر تجريبي — الرسائل مقفولة'],
];

/** Short buttons and labels stay neutral (decision e): pinned so a sentence sweep leaves them be. */
const NEUTRAL: Array<[string, string]> = [
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', "'أرسل الإيصال'"],
  ['apps/web/src/components/ProductModel3d.tsx', "'اعرضه 3D'"],
  ['apps/web/src/components/ProductModel3d.tsx', "'اعرضه في مكانك'"],
  ['apps/web/src/components/UnknownHostNotFound.tsx', "'أنشئ متجرك على ابدأ ستور'"],
  ['apps/web/src/components/UnknownHostNotFound.tsx', "'تواصل معنا عبر واتساب'"],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', "'موعد الوصول'"],
  ['apps/web/src/contexts/LanguageContext.tsx', "'اختر شكلاً'"],
];

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === 'node_modules' || n === '__tests__' || n === 'landing') continue;
      files(p, out);
    } else if (/\.tsx?$/.test(n) && !/\.(test|spec|d)\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/**
 * Every piece of shopper-visible text in a file, from the TypeScript AST: string literals,
 * template-literal text, JSX text nodes and JSX string attributes (review I1: a regex over quoted
 * literals could not see `<p>عذرًا، الصفحة…</p>`). Comments never appear. `messageAr` mode keeps
 * only text inside a `messageAr` property, variable or assignment, however many lines its value
 * spans (review I2).
 */
export function arabicTexts(
  file: string,
  opts: { messageArOnly?: boolean; honourRegions?: boolean } = {}
): Array<{ line: number; text: string }> {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const fenced: Array<[number, number]> = [];
  if (opts.honourRegions) {
    let start = -1;
    src.split('\n').forEach((l, i) => {
      if (REGION_START.test(l)) start = i + 1;
      if (REGION_END.test(l) && start >= 0) {
        fenced.push([start, i + 1]);
        start = -1;
      }
    });
  }
  const out: Array<{ line: number; text: string }> = [];
  const push = (node: ts.Node, text: string) => {
    if (!/[\u0621-\u064A]/.test(text)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (fenced.some(([a, b]) => line >= a && line <= b)) return;
    out.push({ line, text });
  };
  const isMessageAr = (n: ts.Node): boolean => {
    const name =
      ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)
        ? n.name.getText(sf)
        : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? n.left.getText(sf).split('.').pop()
          : undefined;
    return name === 'messageAr';
  };
  const visit = (n: ts.Node, inMessageAr: boolean) => {
    const on = inMessageAr || (opts.messageArOnly ? isMessageAr(n) : true);
    if (on) {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) push(n, n.text);
      else if (ts.isTemplateExpression(n))
        push(n, n.head.text + n.templateSpans.map(sp => '${…}' + sp.literal.text).join(''));
      else if (ts.isJsxText(n)) push(n, n.text);
    }
    ts.forEachChild(n, c => visit(c, opts.messageArOnly ? on : false));
  };
  visit(sf, false);
  return out;
}

/**
 * `messageAr` values that are not text where they are set (`messageAr: MESSAGES_AR[code]`,
 * `messageAr: text[1]`, `messageAr: e.ar`): the text lives in a table elsewhere. Every such file
 * must be in MESSAGE_SOURCE_FILES, which the gate scans in full.
 */
export function indirectMessageAr(file: string): number[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const hasText = (n: ts.Node): boolean =>
    ts.isStringLiteralLike(n) ||
    ts.isTemplateExpression(n) ||
    !!ts.forEachChild(n, c => hasText(c) || undefined);
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'messageAr') {
      const init = n.initializer;
      const named = ts.isIdentifier(init) && init.text === 'messageAr';
      if (!named && !hasText(init))
        lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

/** API files whose Arabic text tables feed `messageAr` indirectly: scanned whole. */
const MESSAGE_SOURCE_FILES = [
  'apps/api/src/lib/upload-sniff.ts',
  'apps/api/src/lib/variant-required.ts',
  'apps/api/src/middleware/store-access.ts',
  'apps/api/src/routes/pwa.routes.ts',
  'apps/api/src/routes/product-model.routes.ts',
  'apps/api/src/services/billing/go-live-gate.ts',
  'apps/api/src/services/cart.service.ts',
  'packages/shared/src/model3d.ts',
];

/** MSA-marker and style-guide hits per repo-relative file. */
export function msaHits(
  paths: string[],
  opts: { messageArOnly?: boolean; honourRegions?: boolean } = {}
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of paths) {
    const rel = relative(ROOT, f);
    for (const { line, text } of arabicTexts(f, opts)) {
      const one = text.replace(/\s+/g, ' ').trim();
      for (const w of one.matchAll(WORD))
        (out[rel] ??= []).push(`${rel}:${line} «${w[1]}» in ${one.slice(0, 80)}`);
      for (const [why, re] of STYLE)
        for (const w of one.matchAll(re))
          (out[rel] ??= []).push(`${rel}:${line} «${w[1]}» (${why}) in ${one.slice(0, 80)}`);
    }
  }
  return out;
}

/** Every hit outside legal text, as one problem list (empty = the rule holds). */
function nonLegalHits(paths: string[], messageArOnly = false): string[] {
  const regionFiles = paths.filter(p => relative(ROOT, p) in LEGAL_REGION_FILES);
  const other = paths.filter(
    p => !(relative(ROOT, p) in LEGAL_FILES) && !(relative(ROOT, p) in LEGAL_REGION_FILES)
  );
  return [
    ...Object.values(msaHits(other, { messageArOnly })).flat(),
    ...Object.values(msaHits(regionFiles, { messageArOnly, honourRegions: true })).flat(),
  ];
}

const storefrontPaths = () => [
  ...files(join(ROOT, 'apps/web/src')),
  ...files(join(ROOT, 'packages/ui/src')),
];

/**
 * SHOPPER-facing messages outside the storefront bundle (Ahmad 2026-10-16: the Egyptian rule
 * extends to the shopper's voice): order/account emails, the SMS + web-push templates, the
 * WhatsApp template bodies sent to shoppers, and the newsletter footer.
 *
 * Merchant-facing messages (merchant emails, merchant push in onesignal.service.ts, the admin)
 * are NOT scanned. The tax-invoice document (`invoice.service.ts`, `fiscal-document-render.ts`)
 * is a legal record and stays formal, so it is not scanned either. A new file in
 * `email-templates/` is scanned by default: it is shopper-facing unless listed in
 * MERCHANT_EMAIL_TEMPLATES.
 */
const MERCHANT_EMAIL_TEMPLATES = [
  '_layout.ts',
  '_util.ts',
  'legal-notice.ts',
  'low-stock-alert.ts',
  'plan-limit-reached.ts',
  'staff-invite.ts',
  'subscription-billing.ts',
];
const SHOPPER_MESSAGE_FILES = [
  'packages/shared/src/notifications.ts',
  'apps/api/src/lib/newsletter-broadcast.ts',
  'apps/api/src/services/campaign.service.ts',
  'apps/api/src/services/email.service.ts',
];
/** Files that may carry a `legal-register` fence inside the shopper-message set. */
const MESSAGE_LEGAL_REGION_FILES: string[] = [];

const shopperMessagePaths = () => [
  ...readdirSync(join(ROOT, 'apps/api/src/services/email-templates'))
    .filter(n => n.endsWith('.ts') && !MERCHANT_EMAIL_TEMPLATES.includes(n))
    .map(n => join(ROOT, 'apps/api/src/services/email-templates', n)),
  ...SHOPPER_MESSAGE_FILES.map(f => join(ROOT, f)),
];

describe('shopper messages: email, SMS, web push (Ruling FU46-Y02a, shopper voice)', () => {
  it('no MSA sentence in any shopper-facing message source', () => {
    const paths = shopperMessagePaths();
    expect(paths.length).toBeGreaterThan(12);
    expect(Object.values(msaHits(paths, { honourRegions: true })).flat()).toEqual([]);
  });

  it('a legal-register fence sits only in a named shopper-message file', () => {
    const stray = shopperMessagePaths()
      .filter(p => REGION_START.test(readFileSync(p, 'utf8')))
      .map(p => relative(ROOT, p))
      .filter(f => !MESSAGE_LEGAL_REGION_FILES.includes(f));
    expect(stray).toEqual([]);
  });

  it('the Egyptian message sentences are pinned', () => {
    const PINNED: Array<[string, string]> = [
      ['apps/api/src/services/email-templates/order-confirmation.ts', 'طلبك اتسجل'],
      ['apps/api/src/services/email-templates/order-shipped.ts', 'طلبك اتشحن'],
      ['packages/shared/src/notifications.ts', 'طلبك رقم #{number} اتأكد'],
    ];
    const missing = PINNED.filter(([f, s]) => !readFileSync(join(ROOT, f), 'utf8').includes(s));
    expect(missing).toEqual([]);
  });
});

describe('storefront Arabic register (Ruling FU46-Y02a: Egyptian sentences, neutral labels)', () => {
  it('no MSA sentence in any storefront string outside the named legal text', () => {
    const paths = storefrontPaths();
    expect(paths.length).toBeGreaterThan(200);
    expect(nonLegalHits(paths)).toEqual([]);
  });

  it('no MSA sentence in an Arabic answer the API gives a shopper (`messageAr`)', () => {
    expect(nonLegalHits(files(join(ROOT, 'apps/api/src')), true)).toEqual([]);
  });

  it('an indirect messageAr comes from a MESSAGE_SOURCE_FILES table, and those tables are Egyptian', () => {
    const api = files(join(ROOT, 'apps/api/src'));
    const stray = api
      .filter(f => indirectMessageAr(f).length > 0)
      .map(f => relative(ROOT, f))
      .filter(f => !MESSAGE_SOURCE_FILES.includes(f));
    expect(stray).toEqual([]);
    const tables = MESSAGE_SOURCE_FILES.map(f => join(ROOT, f));
    expect(Object.values(msaHits(tables)).flat()).toEqual([]);
  });

  it('legal exemptions are named: every listed file exists, and region markers sit only in LEGAL_REGION_FILES', () => {
    for (const f of [...Object.keys(LEGAL_FILES), ...Object.keys(LEGAL_REGION_FILES)])
      expect(() => readFileSync(join(ROOT, f)), f).not.toThrow();
    const stray = storefrontPaths()
      .filter(p => REGION_START.test(readFileSync(p, 'utf8')))
      .map(p => relative(ROOT, p))
      .filter(f => !(f in LEGAL_REGION_FILES));
    expect(stray).toEqual([]);
    for (const f of Object.keys(LEGAL_REGION_FILES)) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, f).toMatch(REGION_START);
      expect((src.match(/legal-register:start/g) ?? []).length, f).toBe(
        (src.match(/legal-register:end/g) ?? []).length
      );
    }
  });

  it("Ahmad's Egyptian sentences are in the files that render them", () => {
    const missing = EGYPTIAN.filter(([f, s]) => !readFileSync(join(ROOT, f), 'utf8').includes(s));
    expect(missing).toEqual([]);
  });

  it('short buttons and labels keep their neutral form', () => {
    const missing = NEUTRAL.filter(([f, s]) => !readFileSync(join(ROOT, f), 'utf8').includes(s));
    expect(missing).toEqual([]);
  });

  it('a \\u-escaped Arabic string is read too (413 single-quoted escaped storefront strings were invisible to the old gate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    const f = join(dir, 'x.tsx');
    // "هذا متجر" written as escapes
    writeFileSync(f, "t('x', '\\u0647\\u0630\\u0627 \\u0645\\u062a\\u062c\\u0631');\n");
    expect(Object.values(msaHits([f])).flat()).toHaveLength(1);
  });

  it('JSX text and a multi-line messageAr are read too (review I1, I2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    const jsx = join(dir, 'x.tsx');
    writeFileSync(
      jsx,
      'export const X = () => (\n  <p>\n    عذرًا، الصفحة التي تبحث عنها غير موجودة\n  </p>\n);\n'
    );
    expect(Object.values(msaHits([jsx])).flat().length).toBeGreaterThan(0);
    const api = join(dir, 'y.ts');
    writeFileSync(
      api,
      "const e = {\n  messageAr:\n    'هذا المتجر للقراءة فقط. ' +\n    'قم بالترقية.',\n  other: 'هذا لا يُقرأ',\n};\n"
    );
    const hits = Object.values(msaHits([api], { messageArOnly: true })).flat();
    expect(hits.length).toBe(3); // هذا, فقط, قم — and nothing from `other`
  });

  it('the style guide: إنت with hamza, joined negation, no حضرتك, عشان', () => {
    const style = (t: string) => STYLE.some(([, re]) => [...t.matchAll(re)].length > 0);
    for (const t of [
      'وانت بتعمل',
      'انت مشترك',
      'ما نفعش',
      'الإيصال ما اتبعتش',
      'حضرتك',
      'علشان كده',
      'ماتقلقش',
      'وماتقلقش',
      'ماينفعش',
      'مافيش',
    ])
      expect(style(t), t).toBe(true);
    for (const t of [
      'وإنت بتعمل',
      'إنت مشترك',
      'منفعش',
      'الإيصال متبعتش',
      'عشان كده',
      'انتظار',
      'متقلقش',
      'ومتقلقش',
      'مفيش',
      'ماتش',
    ])
      expect(style(t), t).toBe(false);
  });

  it('the matcher catches the MSA sentence shapes and leaves Egyptian alone (self-test)', () => {
    const hit = (s: string) => [...s.matchAll(WORD)].length > 0;
    for (const s of [
      'تم تسجيل طلبك، يصلك بين',
      'هذا متجر تجريبي',
      'لم يكتمل الدفع',
      'يرجى إدخال البيانات',
      'قطعتان',
      'المتجر غير متاح حالياً',
      'سيراجع صاحب المتجر التحويل',
      'سلة التسوق فارغة',
      'يجب أن تختار مقاس',
      'كيف يمكنني تتبع طلبي؟',
      'هل تحتاج مساعدة؟',
      'كن أول من يقيّم',
      'حاول مرة أخرى',
      'تم تحديث عنوانك.',
      'تعذّر تحميل القسم',
      'الموضح أدناه',
    ])
      expect(hit(s), s).toBe(true);
    for (const s of [
      'طلبك اتسجل',
      'يوصلك بين',
      'هيوصلك خلال يومين',
      'ده متجر تجريبي',
      'الدفع متمش',
      'قطعتين',
      'المتجر مش متاح دلوقتي',
      'لمّا',
      'التيشيرت',
      'يلمع',
      'الهدية',
      'سلتك فاضية',
      'لازم تختار مقاس',
      'إزاي أتابع طلبي؟',
      'محتاج مساعدة؟',
      'يمكن يوصل بكرة',
      'خليك أول واحد يقيّم',
      'جرّب تاني',
      'عنوانك اتحدّث.',
      'تمام',
      'كنت',
    ])
      expect(hit(s), s).toBe(false);
  });
});
