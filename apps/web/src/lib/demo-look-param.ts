/**
 * The `?look=<id>` wire format, kept dependency-free so the edge middleware can import it
 * without pulling the looks registry into its bundle.
 *
 * Same shape as the DB CHECK on `stores.look` (`stores_look_format`).
 */
export const DEMO_LOOK_PATTERN = /^(qamar|souq|jasmine|lamma|dahab)\.[a-z]+$/;

/** Request header the middleware sets from a validated `?look=` (client-sent copies are stripped). */
export const DEMO_LOOK_HEADER = 'x-demo-look';

/** The look id when `raw` is well-formed, else null. Pure; never throws. */
export function parseDemoLook(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && DEMO_LOOK_PATTERN.test(raw) ? raw : null;
}
