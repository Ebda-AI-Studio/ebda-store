/**
 * Search words for a product: how Egyptian shoppers actually type it (dialect,
 * Franco-Arabic, common misspellings, English). Written into products.search_terms
 * through the autofill engine (field 'searchTerms'); never overwrites a merchant's
 * own words ('human' provenance, or legacy words with no provenance). Bulk quota:
 * it runs from the autofill Inngest function, the 3-day sweep, or the merchant's
 * "Switch to AI" click. Search program P1 (Task 8).
 *
 * The reply is stored through the same `cleanSearchTerms` the merchant field uses
 * (trimmed, deduplicated on the shared Arabic fold, at most 30 terms / 500 chars,
 * the products_search_terms_len_chk limit), after dropping every personal-data-shaped
 * term with the same `isPersonalDataTerm` gate as the search log: a phone or email
 * copied out of a description must never become an indexed search word.
 */
import { SEARCH_TERM_MAX_LENGTH, cleanSearchTerms, isPersonalDataTerm } from '@ebda/shared';
import { GeminiFailoverClient } from './gemini-keys';
import { parseAiJson } from './parse-ai-json';
import { rethrowAsAppError } from './gemini-errors';
import { recordUsage } from '../../services/ai.service';
import { assertAiQuota } from '../ai-quota';
import { inventedAttributeFilter } from './search-terms-attribute-filter';

export interface SearchTermsInput {
  storeId: string;
  storeName: string;
  product: {
    name: string;
    nameAr?: string | null;
    description?: string | null;
    descriptionAr?: string | null;
  };
  categoryNames: string[];
}

export function buildSearchTermsPrompt(i: SearchTermsInput): string {
  const desc = (i.product.descriptionAr || i.product.description || '').slice(0, 600);
  return `You write SEARCH WORDS for a product in an Egyptian online store called ${i.storeName}.
Shoppers in Egypt search in Egyptian Arabic dialect, in Franco-Arabic (Arabic in Latin letters with
digits, e.g. "3abaya", "gazma", "kotshy", "shanta"), with dropped hamza / ta marbuta written as ha,
and in English.

Product (English name): ${i.product.name || '(none)'}
Product (Arabic name): ${i.product.nameAr || '(none)'}
Categories: ${i.categoryNames.join(', ') || '(none)'}
Description: ${desc || '(none)'}

Return 8 to 20 short terms a shopper would TYPE to find this exact product: Egyptian dialect words,
Franco-Arabic spellings, common misspellings, and plain English words. Synonyms of the product type
are good. Do not invent brand names, sizes, colours or materials that are not in the product data,
and do not add a gender, season or use the product data does not state. Write each word in ONE
script (all Arabic letters or all Latin letters/digits). Do not repeat the product name verbatim.
Never include phone numbers, emails, links or prices.

Return ONLY valid JSON: { "terms": ["...", "..."] }`;
}

/**
 * A single WORD mixing Latin and Arabic letters ("fنجان") is a model glitch no shopper types.
 * Mixed-script PHRASES ("طرحة beige") are real Egyptian queries and are kept.
 */
function hasMixedScriptWord(term: string): boolean {
  return term.split(/\s+/).some(w => /[A-Za-z]/.test(w) && /[\u0600-\u06FF]/.test(w));
}

/**
 * M2: a domain-shaped token ("facebook.com/myshop", "shop.eg") is a link without a scheme, which
 * the shared PII gate deliberately lets through for the search log (a shopper may type a site
 * name). On the AI path it is never a search word and can carry a merchant's social handle.
 */
const DOMAIN_LIKE =
  /[a-z0-9-]+\.(?:com|net|org|eg|me|io|ly|co|info|biz|shop|store|online|app|link|page)\b/i;

export async function generateProductSearchTerms(
  input: SearchTermsInput,
  apiKey: string,
  modelName: string
): Promise<string | null> {
  await assertAiQuota({ storeId: input.storeId, bulk: true });
  const model = new GeminiFailoverClient(apiKey).getGenerativeModel({ model: modelName });
  let result;
  try {
    result = await model.generateContent(buildSearchTermsPrompt(input));
  } catch (err) {
    rethrowAsAppError(err, 'AI search terms failed');
  }
  const usage = result.response.usageMetadata;
  await recordUsage(
    input.storeId,
    'search-terms',
    usage?.promptTokenCount ?? 0,
    usage?.candidatesTokenCount ?? 0,
    false,
    { model: modelName }
  );
  // parseAiJson THROWS on a non-JSON reply; an unusable reply is "no words", not an error.
  let parsed: { terms?: unknown } | null;
  try {
    parsed = parseAiJson<{ terms?: unknown }>(result.response.text());
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.terms)) return null;
  // Split on the stored separators FIRST (as cleanSearchTerms will), so the PII gate sees
  // every piece that can end up stored, not a "words, 0101…" string it might pass whole.
  // Enforced, not only asked for (I5): a gender / age / season word the product data never
  // states is dropped. Source = everything the prompt showed the model.
  const invented = inventedAttributeFilter(
    [
      input.product.name,
      input.product.nameAr,
      input.product.description,
      input.product.descriptionAr,
      ...input.categoryNames,
    ]
      .filter(Boolean)
      .join(' ')
  );
  const terms = parsed.terms
    .flatMap(t => (typeof t === 'string' ? t.split(/[,،\n]/) : []))
    .filter(
      t =>
        t.trim() &&
        // M1: cleanSearchTerms would CUT a long piece at 60 (mid-word, and in UTF-16 units).
        // The merchant form warns about that; the AI path has no reviewer, so drop it whole —
        // a 60+ character phrase is never a search word. Counted in code points.
        [...t.trim()].length <= SEARCH_TERM_MAX_LENGTH &&
        !isPersonalDataTerm(t) &&
        !DOMAIN_LIKE.test(t) &&
        !hasMixedScriptWord(t) &&
        !invented(t)
    );
  return cleanSearchTerms(terms.join(','));
}
