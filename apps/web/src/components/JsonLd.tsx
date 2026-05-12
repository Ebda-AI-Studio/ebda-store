/**
 * JsonLd — server component helper for emitting <script type="application/ld+json"> blocks.
 *
 * Usage:
 *   <JsonLd data={breadcrumbJsonLd([...])} />
 *
 * The content is always the result of JSON.stringify on a plain schema.org object
 * produced by our own structured-data helpers — never user-supplied HTML.
 * dangerouslySetInnerHTML is safe here because JSON.stringify escapes every
 * special HTML character that could constitute a script injection vector.
 */

interface JsonLdProps {
  /** A plain schema.org object from lib/structured-data.ts */
  data: object;
}

export function JsonLd({ data }: JsonLdProps) {
  /* eslint-disable-next-line react/no-danger */
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  );
}
