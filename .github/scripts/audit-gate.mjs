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
import { classifyAuditReport, auditExitCode, AUDIT } from './audit-report-verdict.mjs';

const ALLOW = new Map([]);

const { execFileSync } = await import('node:child_process');

/**
 * The advisory endpoint 503s from time to time — observed twice while testing
 * this very change. Failing closed on the first blip would block every merge on
 * a REQUIRED check for a transient, so the attempt is retried before the gate
 * concludes it cannot verify. Retrying is safe: `npm audit` is a read.
 *
 * What is NOT retried is a real answer. Only an unusable one comes back here.
 */
/**
 * Each attempt is bounded so the retry budget provably fits the job budget.
 *
 * Retrying without a per-attempt bound is what turned a fast failure into a
 * slow one: three unbounded attempts against a slow registry ran the step to
 * 7m46s against a 7-minute job timeout, so the job was CANCELLED — which reads
 * as neither pass nor fail and blocks the merge with no finding to act on.
 * A retry that can exceed its own deadline has just moved the failure.
 *
 * ATTEMPTS × (ATTEMPT_TIMEOUT_MS + backoff) must stay under the job's
 * timeout-minutes. At 3 × (60s + ≤10s) that is ~3.5 minutes against 10.
 */
const ATTEMPT_TIMEOUT_MS = 60_000;

function runAudit() {
  try {
    return execFileSync(
      'npm',
      ['audit', '--omit=dev', '--json', '--fetch-timeout=45000', '--fetch-retries=1'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: ATTEMPT_TIMEOUT_MS }
    );
  } catch (e) {
    // npm exits non-zero when vulns exist; the JSON is still on stdout. A
    // timeout kills the child with no stdout, which falls through to the
    // usable-report check and is retried like any other unusable answer.
    return e.stdout;
  }
}

const ATTEMPTS = 3;
let raw;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  raw = runAudit();
  if (raw) {
    let probe;
    try {
      probe = JSON.parse(raw);
    } catch {
      probe = null;
    }
    // A usable report is one that carries the map. Anything else — npm's error
    // envelope, unparseable output — is worth another attempt.
    if (
      probe &&
      !probe.error &&
      probe.vulnerabilities &&
      typeof probe.vulnerabilities === 'object'
    ) {
      break;
    }
  }
  if (attempt < ATTEMPTS) {
    console.error(
      `audit-gate: attempt ${attempt}/${ATTEMPTS} did not return a usable report — retrying`
    );
    execFileSync('sleep', [String(Math.min(attempt * 5, 10))]);
  }
}
if (!raw) {
  console.error('audit-gate: npm audit produced no output after ' + ATTEMPTS + ' attempts');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(raw);
} catch (e) {
  console.error(`audit-gate: npm audit output was not JSON (${e.message}) — cannot verify`);
  process.exit(1);
}

// A report with no vulnerabilities MAP is not a clean report — it is not a
// report. npm emits JSON on failure too, so a registry timeout used to yield
// zero findings and a green "clean" on a REQUIRED check without the advisory
// database ever being consulted.
const { verdict, reason, blocking, waived } = classifyAuditReport(report, ALLOW);
if (verdict === AUDIT.UNUSABLE) {
  console.error(`audit-gate: ${reason}`);
  console.error('audit-gate: refusing to report clean without an audit result.');
  process.exit(auditExitCode(verdict));
}

if (waived.length) {
  console.log('::group::waived (documented, no upstream fix)');
  for (const w of new Set(waived)) console.log('  WAIVED  ' + w);
  console.log('::endgroup::');
}
if (verdict === AUDIT.BLOCKING) {
  console.error('audit-gate: BLOCKING production advisories:');
  for (const b of new Set(blocking)) console.error('  ' + b);
  process.exit(auditExitCode(verdict));
}
console.log(`audit-gate: clean (${new Set(waived).size} documented waiver(s))`);
