/** "First L." from a review's customer, or null when there is no first name to show. */
export function testimonialAuthorName(
  c: { firstName: string | null; lastName: string | null } | null | undefined
): string | null {
  const first = (c?.firstName ?? '').trim();
  if (!first) return null;
  const last = (c?.lastName ?? '').trim().slice(0, 1).toUpperCase();
  return last ? `${first} ${last}.` : first;
}
