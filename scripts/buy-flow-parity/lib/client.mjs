/**
 * HTTP clients that send what the real callers send.
 *
 * Shopper mirrors apps/web/src/lib/api.ts: JSON body, `X-Session-ID`,
 * `X-Store-ID`, `credentials: 'include'` (cookie jar), and `X-CSRF-Token` on
 * writes once a login has issued one. Admin mirrors the admin app's Bearer use.
 *
 * Every call is appended to `steps` as { step, method, path, status, body } —
 * the HTTP half of the snapshot.
 */
import crypto from 'node:crypto';

const LOAD_TEST_TOKEN = 'bfp-parity-load-test-token';
export const HARNESS_ENV = { LOAD_TEST_BYPASS_TOKEN: LOAD_TEST_TOKEN };
export const LOAD_TEST_HEADER = { 'x-load-test-token': LOAD_TEST_TOKEN };

class BaseClient {
  constructor(apiBase, steps) {
    this.apiBase = apiBase;
    this.steps = steps;
    this.cookies = new Map();
    // Called after every response — the harness drains the Inngest executor
    // here, so background functions run right after the request that emitted
    // their event (as they would in production), in a fixed order.
    this.afterCall = null;
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      // Rate limiters are not part of the buy flow under test; the API's own
      // load-test bypass (LOAD_TEST_BYPASS_TOKEN) skips them identically on
      // both refs, so a long scenario list never trips a 429.
      ...LOAD_TEST_HEADER,
    };
  }

  async call(step, method, path, body, extraHeaders = {}) {
    const headers = { ...this.headers(method), ...extraHeaders };
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    const entry = { step, method, path, status: res.status, body: parsed };
    this.steps.push(entry);
    if (this.afterCall) await this.afterCall();
    return entry;
  }
}

export class Shopper extends BaseClient {
  constructor(apiBase, steps, storeId, label) {
    super(apiBase, steps);
    this.storeId = storeId;
    // Deterministic, storefront-shaped session id (sess_ + 32 hex).
    this.sessionId = `sess_${crypto.createHash('sha1').update(`bfp-session:${label}`).digest('hex').slice(0, 32)}`;
    this.csrfToken = null;
  }

  headers(method = 'GET') {
    const h = { ...super.headers(), 'X-Session-ID': this.sessionId, 'X-Store-ID': this.storeId };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && this.csrfToken) {
      h['X-CSRF-Token'] = this.csrfToken;
    }
    return h;
  }

  async register(step, { email, password, firstName, lastName }) {
    return this.call(step, 'POST', '/auth/register', {
      email,
      password,
      firstName,
      lastName,
      storeId: this.storeId,
    });
  }

  async login(step, email, password) {
    const r = await this.call(step, 'POST', '/auth/login', {
      email,
      password,
      storeId: this.storeId,
    });
    this.csrfToken = r.body?.data?.csrfToken ?? null;
    return r;
  }
}

export class Admin extends BaseClient {
  constructor(apiBase, steps) {
    super(apiBase, steps);
    this.token = null;
  }

  headers() {
    const h = super.headers();
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async login(step, email, password) {
    const r = await this.call(step, 'POST', '/auth/login', { email, password });
    this.token = r.body?.data?.accessToken ?? null;
    // Admin uses Bearer only; drop cookies so CSRF never applies.
    this.cookies.clear();
    return r;
  }
}
