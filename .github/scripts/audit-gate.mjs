#!/usr/bin/env node
/**
 * Production audit gate with a NARROW, documented allowlist.
 *
 * Policy is unchanged: production deps are zero-tolerance at `low`. This gate
 * exists only because two advisories currently have NO upstream fix AND are
 * unreachable by npm overrides.
 *
 * Why overrides don't work: both arrive through @grpc/proto-loader@0.8.1, which
 * pins protobufjs 8.6.3. npm registers the override and then does not apply it —
 * `npm ls` reports e.g.
 *   protobufjs@8.6.3 invalid: "8.7.1" from node_modules/@grpc/proto-loader overridden
 * This is the same limitation already documented for @lhci/cli in ci.yml
 * (verified 2026-05-25, re-confirmed 2026-07-21).
 *
 * Why no upgrade: the parent is ALREADY on its latest release —
 *   @grpc/proto-loader@0.8.1 pins protobufjs 8.6.3
 *
 * RE-EVALUATE when @grpc/proto-loader ships a release. Remove an entry the moment
 * its advisory is resolvable — this list must only ever shrink.
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
 * Accepted 2026-07-21 by Ahmad, explicitly and with the risk stated.
 */
const ALLOW = new Map([
  ['GHSA-j3f2-48v5-ccww', 'protobufjs DoS (infinite loop) — @grpc/proto-loader@0.8.1 (latest) pins 8.6.3'],
  // NOT denial-of-service. Prototype-pollution class. Accepted knowingly:
  // reached only via OpenTelemetry -> gRPC telemetry export, not the payment
  // or request-handling path. Highest priority to remove when proto-loader ships.
  ['GHSA-jfj6-75fj-8934', 'protobufjs Text Format map parsing mutation — same unfixable @grpc/proto-loader path'],
]);

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
