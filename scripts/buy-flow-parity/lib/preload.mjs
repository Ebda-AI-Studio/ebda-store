/**
 * Network boundary for the API process under test. Loaded with
 * `node --import <this file> apps/api/dist/index.js`, so it is byte-identical
 * for the base and the head ref and no application code is modified.
 *
 * - Paymob (accept.paymob.com) is rewritten to the harness stub
 *   (`$BFP_STUB_URL/paymob/...`). The adapter's default base URL is the real host, so
 *   this stubs it for a ref that has no `PAYMOB_BASE_URL` override.
 * - Loopback traffic (Postgres, Redis, the stub itself) passes through.
 * - EVERY other host is refused: fetch() is rewritten to the stub's
 *   `/__outbound/<host>/<path>` sink (recorded, answered 503), and http/https
 *   requests are pointed at the same sink. Nothing leaves the machine — no live
 *   gateway, email, push or analytics call can happen from a parity run.
 */
import http from 'node:http';
import https from 'node:https';

const STUB = process.env.BFP_STUB_URL;
if (!STUB) {
  throw new Error(
    '[bfp-preload] BFP_STUB_URL is not set — refusing to start without a network stub'
  );
}
const stubUrl = new URL(STUB);
const PAYMOB_HOSTS = new Set(['accept.paymob.com']);

function isLoopback(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h === '0.0.0.0';
}

function rewrite(urlStr) {
  const u = new URL(urlStr);
  if (PAYMOB_HOSTS.has(u.hostname)) return `${STUB}/paymob${u.pathname}${u.search}`;
  if (isLoopback(u.hostname)) return null;
  return `${STUB}/__outbound/${u.hostname}${u.pathname}${u.search}`;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async function bfpFetch(input, init) {
  let urlStr;
  if (typeof input === 'string') urlStr = input;
  else if (input instanceof URL) urlStr = input.href;
  else if (input && typeof input.url === 'string') urlStr = input.url;
  const target = urlStr ? rewrite(urlStr) : null;
  if (!target) return realFetch(input, init);
  if (typeof input === 'string' || input instanceof URL) return realFetch(target, init);
  // Request object: rebuild against the new URL, keeping method/headers/body.
  const req = input;
  const body = req.body ? await req.arrayBuffer() : undefined;
  return realFetch(target, {
    method: req.method,
    headers: req.headers,
    body,
    ...(init || {}),
  });
};

function patchModule(mod) {
  const origRequest = mod.request;
  const origGet = mod.get;
  function redirect(args) {
    // Normalise (url?, options?, cb?) → { host, path }.
    let url;
    let options = {};
    let cb;
    for (const a of args) {
      if (typeof a === 'string' || a instanceof URL) url = new URL(a);
      else if (typeof a === 'function') cb = a;
      else if (a && typeof a === 'object') options = a;
    }
    const host = options.hostname || options.host || (url && url.hostname) || 'localhost';
    if (isLoopback(host)) return null;
    const path = options.path || (url ? url.pathname + url.search : '/');
    const redirected = {
      protocol: 'http:',
      hostname: stubUrl.hostname,
      port: stubUrl.port,
      method: options.method || 'GET',
      path: `/__outbound/${String(host).split(':')[0]}${path}`,
      headers: options.headers || {},
    };
    return { redirected, cb };
  }
  mod.request = function (...args) {
    const r = redirect(args);
    if (!r) return origRequest.apply(this, args);
    return httpOrigRequest(r.redirected, r.cb);
  };
  mod.get = function (...args) {
    const r = redirect(args);
    if (!r) return origGet.apply(this, args);
    const req = httpOrigRequest(r.redirected, r.cb);
    req.end();
    return req;
  };
}

const httpOrigRequest = http.request.bind(http);
patchModule(http);
patchModule(https);
