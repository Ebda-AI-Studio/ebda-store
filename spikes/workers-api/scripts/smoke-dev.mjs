// Second, independent harness: drives a real `wrangler dev` (workerd 1.20261001) over HTTP with a spoofed Host header.
// usage: npx wrangler dev --port 8799 &  node scripts/smoke-dev.mjs
import http from 'node:http';
const req = (host, path, method = 'GET', body, headers = {}) =>
  new Promise((res, rej) => {
    const r = http.request(
      { host: '127.0.0.1', port: 8799, path, method, headers: { host, ...headers } },
      m => {
        let d = '';
        m.on('data', c => (d += c));
        m.on('end', () => res({ status: m.statusCode, body: d, headers: m.headers }));
      }
    );
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
const hosts = [
  ['amelia.ebda.app', 'Amelia', 3],
  ['rival.ebda.app', 'Rival', 2],
];
let leaks = 0,
  bad = 0;
const N = 240,
  C = 24;
let i = 0;
const t0 = Date.now();
await Promise.all(
  Array.from({ length: C }, async () => {
    while (i < N) {
      const k = i++,
        [h, pre, n] = hosts[k % 2];
      const r = await req(h, '/products');
      if (r.status !== 200) {
        bad++;
        continue;
      }
      const { products } = JSON.parse(r.body);
      if (products.length !== n || products.some(p => !p.name.startsWith(pre))) leaks++;
    }
  })
);
const u = await req('nope.ebda.app', '/products'),
  a = await req('store.ebda.app', '/products');
console.log(
  JSON.stringify({
    requests: N,
    concurrency: C,
    ms: Date.now() - t0,
    leaks,
    nonOk: bad,
    unknownHost: u.status,
    reservedHost: a.status,
  })
);
process.exit(leaks || bad || u.status !== 404 || a.status !== 404 ? 1 : 0);
