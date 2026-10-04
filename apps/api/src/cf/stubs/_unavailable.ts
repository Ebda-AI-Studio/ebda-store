/** Shared by the stubs below: a loud, specific failure instead of a mystery TypeError. */
export function unavailable(what: string, why: string): never {
  throw new Error(`[workers] ${what} is not available on Cloudflare Workers: ${why}`);
}
