/**
 * AI-narration body picker shared by every insights page (segments,
 * dashboard, cohorts, funnel). The API already returns both `en` and `ar`
 * narration bodies; before this each page's label was translated but the
 * body was hardcoded to `.en`, so an Arabic-locale admin saw a translated
 * heading immediately followed by an English paragraph with the fetched
 * Arabic copy discarded (issue #1933). Falls back to `en` for rows written
 * before the AI produced an Arabic variant.
 */
export interface AiNarration {
  en: string;
  ar: string;
}

export function pickNarration(
  narration: AiNarration | null | undefined,
  locale: string
): string | undefined {
  if (!narration) return undefined;
  if (locale === 'ar') return narration.ar || narration.en || undefined;
  return narration.en || undefined;
}
