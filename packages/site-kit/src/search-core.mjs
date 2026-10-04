// Search options shared by the build-time indexer and the browser client, so a serialized
// MiniSearch index is loaded with exactly the options it was built with.
const DIACRITICS = /[ً-ٰٟـ]/g; // tashkeel, superscript alef, tatweel

/** Arabic + Latin normalisation: strip diacritics, unify alef/yeh/teh-marbuta, lowercase. */
export function normalizeTerm(term) {
  return term
    .replace(DIACRITICS, '')
    .replace(/[آأإ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

export const searchOptions = {
  idField: 'id',
  fields: ['title', 'headings', 'text'],
  storeFields: ['title', 'section', 'lang', 'snippet'],
  processTerm: term => {
    const t = normalizeTerm(term);
    return t.length ? t : null;
  },
};

export const querySettings = {
  boost: { title: 4, headings: 2 },
  prefix: true,
  fuzzy: term => (term.length > 4 ? 0.15 : false),
  combineWith: 'AND',
};
