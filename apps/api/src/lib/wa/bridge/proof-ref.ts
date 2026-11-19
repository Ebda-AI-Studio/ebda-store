/**
 * WA-1: the proof URL Chat sends is signed (`sig`, 72 h) and works as a bearer link, so it never goes into the audit trail
 * (readable by every merchant staff role, exported, drained to logs). Keep a reference only: origin + path with the query
 * and fragment dropped (where the signature lives), no credentials.
 */
export function proofRef(mediaUrl: string): string {
  try {
    const u = new URL(mediaUrl);
    return `${u.origin}${u.pathname}`.slice(0, 300);
  } catch {
    return 'invalid-url';
  }
}
