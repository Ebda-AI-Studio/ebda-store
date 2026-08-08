#!/usr/bin/env node
/**
 * Production audit gate with a NARROW, documented allowlist.
 *
 * Policy: production deps are zero-tolerance at `low`. The allowlist exists only
 * for advisories with NO upstream fix that are ALSO unreachable by npm overrides.
 * It must only ever shrink — remove an entry the moment its advisory is
 * resolvable.
 *
 * EMPTY as of 2026-08-08 — the gate currently waives nothing.
 *
 * Shrunk 2026-08-08: both protobufjs waivers (GHSA-j3f2-48v5-ccww DoS,
 * GHSA-jfj6-75fj-8934 Text Format map mutation) REMOVED. Their stated premise —
 * "npm registers the override and then does not apply it" — is no longer true:
 * protobufjs resolves to 8.7.1 on this branch AND on main (both lockfiles pin
 * it), and `npm audit --omit=dev` reports the package clean. The gate confirmed
 * it independently by reporting 0 waivers used before these entries were
 * deleted. `npm ls` still marks it `invalid: "^7.5.5" from @grpc/proto-loader`,
 * but that is a declared-range complaint, not an unapplied override, and it is
 * pre-existing on main. Dead waivers are not free — they would silently absorb
 * a future protobufjs advisory we would otherwise be forced to look at.
 *
 * Shrunk 2026-07-22: body-parser (GHSA-v422), brace-expansion (GHSA-3jxr) and
 * js-yaml (GHSA-52cp) are RESOLVED and removed. body-parser deduped to 1.20.6;
 * brace-expansion patched to 1.1.16/2.1.2 (both patched versions now published);
 * js-yaml override bumped 4.2.0 -> 4.3.0. A clean lockfile regen (rm -rf
 * node_modules package-lock.json && npm install) applied the overrides that a
 * partial regen left stale, and the esbuild pin the js-yaml waiver feared is a
 * non-issue — @opennextjs/aws keeps its own nested esbuild@0.25.4 while the
 * top-level stays 0.28.1, exactly as before. sharp (GHSA-f88m) and
 * @opentelemetry/propagator-jaeger (GHSA-45rx) were fixed the same pass (sharp
 * ^0.35.3 direct + override, propagator-jaeger ^2.9.0 leaf override — no
 * breaking sdk-node major bump). None ever needed a waiver.
 *
 * Adding an entry needs Ahmad's explicit acceptance with the risk stated — the
 * same bar the (now removed) protobufjs pair was held to on 2026-07-21.
 */
const ALLOW = new Map([]);

const { execFileSync } = await import('node:child_process');
let raw;
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  raw = e.stdout; // npm exits non-zero when vulns exist; the JSON is still on stdout
}
if (!raw) { console.error('audit-gate: npm audit produced no output'); process.exit(1); }

const report = JSON.parse(raw);
const blocking = [];
const waived = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (typeof via !== 'object') continue;
    const id = (via.url ?? '').split('/').pop();
    (ALLOW.has(id) ? waived : blocking).push(`${name} ${via.severity} ${id} — ${via.title ?? ''}`);
  }
}

if (waived.length) {
  console.log('::group::waived (documented, no upstream fix)');
  for (const w of new Set(waived)) console.log('  WAIVED  ' + w);
  console.log('::endgroup::');
}
if (blocking.length) {
  console.error('audit-gate: BLOCKING production advisories:');
  for (const b of new Set(blocking)) console.error('  ' + b);
  process.exit(1);
}
console.log(`audit-gate: clean (${new Set(waived).size} documented waiver(s))`);
