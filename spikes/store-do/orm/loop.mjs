// External wall-clock loop against the local ORM worker (workerd's in-worker performance.now()
// does not advance during synchronous CPU, so construction cost must be measured from outside).
const base = process.argv[2] ?? 'http://localhost:8799';
const n = Number(process.argv[3] ?? 300);
const q = s => s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
for (const [impl, op] of [
  ['drizzle', 'products'],
  ['prisma', 'products'],
  ['drizzle', 'cart'],
  ['prisma', 'cart'],
]) {
  await fetch(`${base}/orm/${impl}/seed`, { method: 'POST' });
  for (let i = 0; i < 20; i++) await (await fetch(`${base}/orm/${impl}/${op}`)).arrayBuffer();
  const t = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fetch(`${base}/orm/${impl}/${op}?sid=s${impl}${i}`);
    await r.arrayBuffer();
    if (r.status !== 200) throw new Error(`${impl}/${op} ${r.status}`);
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      impl,
      op,
      n,
      p50_ms: +t[Math.floor(n / 2)].toFixed(2),
      p95_ms: +q(t).toFixed(2),
      max_ms: +t[n - 1].toFixed(2),
    })
  );
}
