#!/usr/bin/env node
/**
 * First-hit TTFB probe (Ruling WEB-COLD-3). One curl per path, new connection each time, printing what decided the time:
 * the edge-cache verdict headers (`x-demo-edge`, `x-store-edge`) and the data centre (`cf-ray` suffix). A first hit per data
 * centre is a `MISS` (a live render); the second is a `HIT`. Read-only GETs.
 *
 *   node scripts/ops/ttfb-probe.mjs [host=storedemo.ebda.app] [paths=/ar,/ar,/health]
 *
 * Behind an ISP that blocks Cloudflare IPs the script resolves the host through 8.8.8.8 and pins it with curl --resolve.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Pure: the facts of one response worth keeping, from curl's `-D -` header dump. */
export function parseProbe(headerDump) {
  const h = {};
  for (const line of String(headerDump).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const ray = h['cf-ray'] ?? '';
  return {
    colo: ray.includes('-') ? ray.split('-').pop() : null,
    demoEdge: h['x-demo-edge'] ?? null,
    storeEdge: h['x-store-edge'] ?? null,
    cfCache: h['cf-cache-status'] ?? null,
  };
}

/** Pure: label a row so a run reads without the headers. The demo layer decides when present, else the store layer; neither = not a page. */
export function classify(p, ttfbS) {
  const verdict = p.demoEdge ?? p.storeEdge;
  const kind = verdict === 'MISS' ? 'cold-render' : verdict ? 'cached' : 'no-edge-cache';
  return `${kind}${ttfbS >= 1 ? ' SLOW(>=1s)' : ''}`;
}

function resolveIp(host) {
  const r = spawnSync('dig', ['+short', '@8.8.8.8', host], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).pop();
}

function main() {
  const host = process.argv[2] ?? 'storedemo.ebda.app';
  const paths = (process.argv[3] ?? '/ar,/ar,/health').split(',');
  const ip = resolveIp(host);
  if (!ip) throw new Error(`cannot resolve ${host}`);
  for (const p of paths) {
    const r = spawnSync(
      'curl',
      [
        '-s',
        '-m',
        '30',
        '--resolve',
        `${host}:443:${ip}`,
        `https://${host}${p}`,
        '-o',
        '/dev/null',
        '-D',
        '-',
        '-w',
        '\nTTFB %{time_starttransfer}\n',
      ],
      { encoding: 'utf8' }
    );
    const ttfb = Number(/TTFB ([\d.]+)/.exec(r.stdout)?.[1] ?? NaN);
    const facts = parseProbe(r.stdout);
    console.log(
      `${p}\tttfb=${ttfb}s\tcolo=${facts.colo}\tdemo=${facts.demoEdge}\tstore=${facts.storeEdge}\t${classify(facts, ttfb)}`
    );
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
