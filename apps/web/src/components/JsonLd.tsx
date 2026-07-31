import { jsonLdScriptContent } from '../lib/json-ld-script';

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

export function JsonLd({ data }: JsonLdProps) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: jsonLdScriptContent(data) }}
    />
  );
}
