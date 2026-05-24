/**
 * Pick the best meta description for a render context. AEO content
 * (conversational answer-engine copy) takes precedence over traditional
 * SEO copy when present. Both fall back to the entity's main description
 * when neither AEO nor SEO has been written.
 */
export function pickMetaDescription(
  entity: {
    metaDescriptionAeo?: string | null;
    metaDescriptionAeoAr?: string | null;
    metaDescription?: string | null;
    metaDescriptionAr?: string | null;
    description?: string | null;
    descriptionAr?: string | null;
  },
  locale: 'en' | 'ar' = 'en'
): string | undefined {
  if (locale === 'ar') {
    return (
      entity.metaDescriptionAeoAr?.trim() ||
      entity.metaDescriptionAr?.trim() ||
      entity.descriptionAr?.trim() ||
      undefined
    );
  }
  return (
    entity.metaDescriptionAeo?.trim() ||
    entity.metaDescription?.trim() ||
    entity.description?.trim() ||
    undefined
  );
}
