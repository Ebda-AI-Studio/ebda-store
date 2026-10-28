import { headers } from 'next/headers';
import { jsonLdScriptContent } from '../lib/json-ld-script';
import { LOCALE_PATH_HEADER, localizeJsonLdUrls } from '../lib/locale-paths';

/**
 * JsonLd — server component helper for emitting <script type="application/ld+json"> blocks.
 *
 * Usage:
 *   <JsonLd data={breadcrumbJsonLd([...])} />
 *
 * Serialization goes through `jsonLdScriptContent`, NOT bare `JSON.stringify`.
 * These payloads carry attacker-reachable text (product names, FAQ entries,
 * customer review bodies and review author names), and `JSON.stringify` does
 * NOT escape `<`/`>` — a `</script>` inside any string closes this block and
 * turns the remainder into executable markup. See that helper for the full
 * rationale and the disproven claim it replaces.
 */

interface JsonLdProps {
  /** A plain schema.org object from lib/structured-data.ts */
  data: object;
}

export async function JsonLd({ data }: JsonLdProps) {
  // On a `/ar|/en` page of a store with language-in-the-URL ON (LOCALE-PATHS-1), every URL the graph names on the store's
  // own origin (`url`, breadcrumb `item`, `@id`...) carries the page's language prefix, like the canonical.
  const h = await headers();
  const lang = h.get(LOCALE_PATH_HEADER);
  const host = h.get('x-store-domain');
  const localized =
    (lang === 'ar' || lang === 'en') && host
      ? localizeJsonLdUrls(data, `https://${host}`, lang)
      : data;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: jsonLdScriptContent(localized) }}
    />
  );
}
