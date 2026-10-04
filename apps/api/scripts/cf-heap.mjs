#!/usr/bin/env node
// Isolate heap of a running `wrangler dev` through its inspector (Runtime.getHeapUsage).
//   node scripts/cf-heap.mjs [--inspector ws://localhost:9229/ws] [--watch ms --out file.csv]
// One-shot prints JSON {usedMB, totalMB}. With --watch it samples until killed and prints (or
// appends) `epoch_ms,usedMB,totalMB`. The live floor is the MINIMUM of a watch (the inspector in
// workerd does not honour HeapProfiler.collectGarbage, so a single sample can be a pre-GC peak).
import { appendFileSync } from 'node:fs';
import WebSocket from 'ws';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? d : (process.argv[i + 1] ?? true);
};
const url = arg('--inspector', 'ws://localhost:9229/ws');
const watch = Number(arg('--watch', 0));
const out = arg('--out', '');

const ws = new WebSocket(url);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise(resolve => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.on('message', data => {
  const m = JSON.parse(String(data));
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result ?? m.error);
    pending.delete(m.id);
  }
});
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
});
const sample = async () => {
  const r = await send('Runtime.getHeapUsage');
  return {
    usedMB: +(r.usedSize / 1048576).toFixed(1),
    totalMB: +(r.totalSize / 1048576).toFixed(1),
  };
};
if (!watch) {
  console.log(JSON.stringify(await sample()));
  ws.close();
  process.exit(0);
} else {
  for (;;) {
    const s = await sample();
    const line = `${Date.now()},${s.usedMB},${s.totalMB}`;
    if (out) appendFileSync(out, line + '\n');
    else console.log(line);
    await new Promise(r => setTimeout(r, watch));
  }
}
