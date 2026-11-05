/**
 * Dependency-free digit normaliser. Lives apart from `instapay-receipt` (which imports zod) so zero-dependency
 * bundles such as the marketing contact form do not pull zod up-front.
 */

/** Eastern Arabic (and Persian) digits to ASCII. */
export function toAsciiDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));
}
