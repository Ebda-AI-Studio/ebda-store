#!/usr/bin/env node
// InstaPay auto-confirm rollout gate (Ruling INSTAPAY-AUTO-1, plan task R1 step 2): the multi-service env-drift check. Fails LOUD (exit 1)
// unless every service reports `instapayAuto.ready: true` on its /health. It reads names, never values. READ-ONLY: it changes nothing,
// and it never turns auto-confirm on (the mode stays whatever a super-admin set; the default is `off`).
//   node scripts/instapay-auto-rollout-check.mjs --store https://api.ebda.app/health --chat https://<chat-host>/health [--brain https://<brain-host>/health]
import process from 'node:process';

const arg = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Pure, tested: a service is ready only when /health carries instapayAuto.ready === true. Anything else names what is missing. */
export function verdictFor(name, body) {
  const a = body && typeof body === 'object' ? body.instapayAuto : undefined;
  if (!a || typeof a !== 'object')
    return { name, ok: false, why: 'no instapayAuto block on /health (old deploy?)' };
  if (a.ready === true) return { name, ok: true, why: '' };
  const missing = Array.isArray(a.missing) ? a.missing.join(', ') : 'unknown';
  return { name, ok: false, why: `not ready, missing: ${missing}` };
}

async function probe(name, url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { name, ok: false, why: `HTTP ${res.status}` };
    return verdictFor(name, await res.json());
  } catch (err) {
    return {
      name,
      ok: false,
      why: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targets = [
    ['store', arg('store')],
    ['chat', arg('chat')],
    ['brain', arg('brain')],
  ].filter(([, u]) => u);
  if (targets.length === 0) {
    console.error('give at least one of --store --chat --brain (a /health URL)');
    process.exit(2);
  }
  const results = await Promise.all(targets.map(([n, u]) => probe(n, u)));
  for (const r of results)
    console.log(`${r.ok ? 'READY    ' : 'NOT READY'} ${r.name}${r.why ? `: ${r.why}` : ''}`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
