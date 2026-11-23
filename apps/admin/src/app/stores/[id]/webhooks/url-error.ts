/**
 * Which field-level reason the API gave for a refused webhook URL, as a key under `webhooks.form.urlErrors`.
 * Two sources: the shared schema's `details.url = [code]` (VALIDATION_ERROR, answered before any network check) and the
 * live check's `details.reason` (WEBHOOK_URL_REJECTED: DNS, private address). `null` = not a URL problem.
 */
const SHAPE = new Set([
  'not_a_url',
  'https_required',
  'credentials_not_allowed',
  'port_not_allowed',
  'ip_literal_not_allowed',
  'public_hostname_required',
  'internal_hostname_not_allowed',
  'platform_host_not_allowed',
]);

export function webhookUrlErrorKey(error: {
  code: string;
  details?: Record<string, unknown>;
}): string | null {
  if (error.code === 'VALIDATION_ERROR') {
    const url = error.details?.url;
    const first = Array.isArray(url) ? String(url[0] ?? '') : '';
    if (SHAPE.has(first)) return first;
    return url ? 'invalid' : null;
  }
  if (error.code === 'WEBHOOK_URL_REJECTED') {
    const reason = String(error.details?.reason ?? '');
    if (reason.startsWith('DNS_UNRESOLVED')) return 'dns_unresolved';
    if (/private|loopback/.test(reason)) return 'private_address';
    return 'rejected';
  }
  return null;
}
