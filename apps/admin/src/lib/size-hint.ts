/**
 * Image-size hints are composed in English by @ebda/shared ("Recommended: 400×200px wordmark OR ..."). In the Arabic
 * admin they showed up verbatim (audit S-1). This maps the fixed vocabulary of those hints once, for every uploader.
 */
const AR_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/Recommended:/g, 'الحجم الموصى به:'],
  [/\s*px\b/g, ' بكسل'],
  [/\bwordmark\b/g, 'شعار أفقي'],
  [/\bsquare brandmark\b/g, 'شعار مربع'],
  [/\bOR\b/g, 'أو'],
  [/\blandscape\b/g, 'أفقي'],
  [/\bportrait\b/g, 'رأسي'],
  [/\bsquare\b/g, 'مربع'],
];

export function localizeSizeHint(hint: string, locale: string): string {
  if (locale !== 'ar') return hint;
  return AR_REPLACEMENTS.reduce((acc, [re, to]) => acc.replace(re, to), hint);
}
