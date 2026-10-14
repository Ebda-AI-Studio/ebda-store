/**
 * Safety guards for `commerce-b0.spec.ts`, which WRITES (stock, COD config, a size chart,
 * product PUTs, an order and its cancellation). Kept in their own file so a unit test can pin them.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost');
}

/**
 * Throws unless EVERY url is http(s) on localhost, 127.0.0.1, [::1] or `*.localhost`.
 * There is deliberately no override: this spec must never write to a deployed environment.
 */
export function assertLocalOnly(urls: Record<string, string>): void {
  for (const [name, raw] of Object.entries(urls)) {
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      throw new Error(`commerce-b0: ${name} is not a valid URL: ${raw}`);
    }
    if (!isLocalHostname(host)) {
      throw new Error(
        `commerce-b0 writes data and only runs against a LOCAL stack; refusing ${name}=${raw} ` +
          `(host "${host}" is not localhost, 127.0.0.1, [::1] or *.localhost). There is no override.`
      );
    }
  }
}

/** The buyer email of an admin order payload (guest orders keep it on the shipping address). */
export function orderBuyerEmail(order: unknown): string | null {
  const o = (order ?? {}) as Record<string, any>;
  const raw = o.shippingAddress?.email ?? o.customer?.email ?? o.guestEmail ?? o.email ?? null;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : null;
}

/** True only when the order was placed by THIS run (its unique buyer email). */
export function orderBelongsToRun(order: unknown, runEmail: string): boolean {
  return orderBuyerEmail(order) === runEmail.trim().toLowerCase();
}
