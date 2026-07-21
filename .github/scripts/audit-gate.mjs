#!/usr/bin/env node
/**
 * Production audit gate with a NARROW, documented allowlist.
 *
 * Policy is unchanged: production deps are zero-tolerance at `low`. This gate
 * exists only because four advisories currently have NO upstream fix AND are
 * unreachable by npm overrides.
 *
 * Why overrides don't work: all four arrive through workspace-hoisted trees
 * (@force/api -> ./apps/api, @force/admin -> ./apps/admin). npm registers the
 * override and then does not apply it — `npm ls` reports e.g.
 *   protobufjs@8.6.3 invalid: "8.7.1" from node_modules/@grpc/proto-loader overridden
 * This is the same limitation already documented for @lhci/cli in ci.yml
 * (verified 2026-05-25, re-confirmed 2026-07-21).
 *
 * Why no upgrade: every parent is ALREADY on its latest release —
 *   express@4.22.2                    requires body-parser ~1.20.5
 *   @grpc/proto-loader@0.8.1          pins protobufjs 8.6.3
 *   @sentry/bundler-plugin-core@5.3.0 pins glob 13.0.6 -> brace-expansion
 *
 * RE-EVALUATE when any parent above ships a release. Remove an entry the moment
 * its advisory is resolvable — this list must only ever shrink.
 *
 * Accepted 2026-07-21 by Ahmad, explicitly and with the risk stated.
 */
const ALLOW = new Map([
  ['GHSA-v422-hmwv-36x6', 'body-parser <1.20.6 DoS — express@4.22.2 (latest 4.x) requires ~1.20.5'],
  ['GHSA-3jxr-9vmj-r5cp', 'brace-expansion DoS — via glob/rimraf/readdir-glob under @sentry/bundler-plugin-core@5.3.0 (latest)'],
  ['GHSA-j3f2-48v5-ccww', 'protobufjs DoS (infinite loop) — @grpc/proto-loader@0.8.1 (latest) pins 8.6.3'],
  // NOT denial-of-service. Prototype-pollution class. Accepted knowingly:
  // reached only via OpenTelemetry -> gRPC telemetry export, not the payment
  // or request-handling path. Highest priority to remove when proto-loader ships.
  ['GHSA-jfj6-75fj-8934', 'protobufjs Text Format map parsing mutation — same unfixable @grpc/proto-loader path'],
  // js-yaml IS fixable in principle: an override pinning it to 4.2.0 (inside the
  // vulnerable range) was the cause, and 4.3.0 clears it. That fix is DEFERRED,
  // not forgotten — applying it requires regenerating package-lock.json, which
  // surfaces an unsatisfiable esbuild constraint (@opennextjs/aws pins 0.25.4
  // exactly while tsx/wrangler need 0.28.1) that makes npm ci reject the lock on
  // every platform. Resolve the esbuild pin first, then remove this entry AND
  // set the override to 4.3.0. Tracked 2026-07-21.
  ['GHSA-52cp-r559-cp3m', 'js-yaml quadratic CPU — DEFERRED fix, blocked on the esbuild lockfile constraint (see above)'],
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
