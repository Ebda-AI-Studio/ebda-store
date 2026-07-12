/**
 * Deterministic FAQ grounding guard.
 *
 * Prompt rules reduce hallucination but never eliminate it — Gemini Flash Lite
 * can still assert a spec that isn't true (the "200g" failure where the product
 * actually ships in 400/700 Gram sizes). This is a NON-model check that runs
 * AFTER generation: it extracts measurement claims (a number paired with a
 * weight/volume/length unit) from each answer and drops any FAQ whose answer
 * states a measurement that does NOT appear in the product's known facts
 * (name / description / variant options).
 *
 * Scope is deliberately narrow + high-precision: only NUMBER+UNIT claims are
 * checked (the most common and most damaging invented spec). Quantities without
 * a measurement unit ("2-3 days", "3 packs", "5 KWD") are ignored, so policy /
 * shipping / pricing answers are never falsely dropped. It does not attempt to
 * verify qualitative claims (ingredients, materials) — those aren't
 * deterministically checkable and are left to the prompt + merchant review.
 */
import type { GeneratedProductFaq, GenerateProductFaqsInput } from './product-faq-generator';

type FaqProduct = GenerateProductFaqsInput['product'];

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII, so "٤٠٠" == "400". */
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, d => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * Canonical class for a measurement unit token, or null if it isn't one we
 * check. Units are kept DISTINCT (g ≠ kg) — the model is told to echo the
 * listed values verbatim, so we never do cross-unit conversion; an exact
 * (number, unit-class) match is the contract.
 */
function unitClass(unit: string): string | null {
  const u = unit.toLowerCase();
  if (/^(?:kg|kilograms?|كجم|كيلوجرام|كيلوغرام|كيلو)$/.test(u)) return 'kg';
  if (/^(?:mg|ملغ|مليجرام)$/.test(u)) return 'mg';
  if (/^(?:g|gm|grams?|جم|جرام|غرام|جرامات)$/.test(u)) return 'g';
  if (/^(?:ml|مل|مليلتر)$/.test(u)) return 'ml';
  if (/^(?:l|lt|litres?|liters?|لتر)$/.test(u)) return 'l';
  if (/^(?:cm|سم|سنتيمتر)$/.test(u)) return 'cm';
  if (/^(?:mm|مم|ميليمتر)$/.test(u)) return 'mm';
  if (/^(?:oz|ounces?|أونصة|اونصة)$/.test(u)) return 'oz';
  if (/^(?:lb|lbs|pounds?)$/.test(u)) return 'lb';
  // NOTE: bare "in" is deliberately excluded — it's the English preposition
  // ("3 in stock", "available in 2 sizes") and would false-positive as inches,
  // wrongly dropping legitimate FAQs. Only spelled-out inch units are matched.
  if (/^(?:inch|inches|بوصة)$/.test(u)) return 'in';
  return null;
}

// number (ASCII or Arabic digits, optional decimal) then optional space then a
// letter run (Latin or Arabic). The letter run is classified as a unit or not.
const MEASURE_RE = /([0-9٠-٩۰-۹]+(?:[.,][0-9٠-٩۰-۹]+)?)\s*([A-Za-z؀-ۿ]+)/g;

/** Set of `"<number>:<unitClass>"` tokens found in a piece of text. */
export function extractMeasurements(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const src = normalizeDigits(text);
  for (const m of src.matchAll(MEASURE_RE)) {
    const cls = unitClass(m[2]);
    if (!cls) continue;
    const num = parseFloat(m[1].replace(',', '.'));
    if (!Number.isFinite(num)) continue;
    out.add(`${num}:${cls}`);
  }
  return out;
}

/** All measurement tokens the product legitimately supports (the allow-set). */
function knownMeasurements(product: FaqProduct): Set<string> {
  const parts: string[] = [product.name, product.nameAr ?? '', product.description ?? ''];
  for (const o of product.options ?? []) {
    if (!o?.values) continue;
    for (const v of o.values) {
      parts.push(v.value);
      if (v.valueAr) parts.push(v.valueAr);
    }
  }
  return extractMeasurements(parts.join(' \n '));
}

export interface FaqGroundingResult {
  kept: GeneratedProductFaq[];
  dropped: { faq: GeneratedProductFaq; offending: string[] }[];
}

/**
 * Filter out FAQs that assert an ungrounded measurement. A FAQ is dropped when
 * its answer (EN or AR) contains a number+unit token absent from the product's
 * known facts. Returns the surviving FAQs plus the dropped ones (with the
 * offending tokens) for logging.
 */
export function validateFaqGrounding(
  faqs: GeneratedProductFaq[],
  product: FaqProduct
): FaqGroundingResult {
  const allowed = knownMeasurements(product);
  const kept: GeneratedProductFaq[] = [];
  const dropped: { faq: GeneratedProductFaq; offending: string[] }[] = [];

  for (const f of faqs) {
    const claimed = extractMeasurements(`${f?.answer ?? ''} \n ${f?.answerAr ?? ''}`);
    const offending = [...claimed].filter(tok => !allowed.has(tok));
    if (offending.length > 0) dropped.push({ faq: f, offending });
    else kept.push(f);
  }
  return { kept, dropped };
}
