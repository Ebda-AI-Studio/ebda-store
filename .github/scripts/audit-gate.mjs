#!/usr/bin/env node
/**
 * Production audit gate with a NARROW, documented allowlist.
 *
 * Policy: production deps are zero-tolerance at `low`. The allowlist exists only
 * for advisories with NO upstream fix that are ALSO unreachable by npm overrides.
 * It must only ever shrink — remove an entry the moment its advisory is
 * resolvable.
 *
 * The waivers moved to `.github/audit-allow.json` (Ruling AUDIT-SPLIT-1, 2026-11-17) with an expiry per entry. First entry: picomatch
 * GHSA-fc5q-39xc-vjpf (no patched version; build-time tooling only), expires 2026-12-17.
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
import { loadAllow } from './audit-allow.mjs';

/**
 * Ruling AUDIT-SPLIT-1: the waivers live in `.github/audit-allow.json` (id, package, reason, EXPIRY), not in this file. An expired or
 * malformed entry fails the gate by itself. Two scopes:
 *   (default)  production dependencies (`npm audit --omit=dev`): BLOCKING.
 *   --all      every dependency incl. development tooling: run as a NON-blocking report step (continue-on-error in the workflow),
 *              it still exits 1 for an advisory that is not allow-listed so the step shows red without stopping the merge.
 */
const ALL = process.argv.includes('--all');
const { allow: ALLOW, expired, invalid } = loadAllow(
  new URL('../audit-allow.json', import.meta.url).pathname
);
if (invalid.length || expired.length) {
  console.error('audit-gate: the allow-list needs attention:');
  for (const m of [...invalid, ...expired]) console.error('  ' + m);
  process.exit(1);
}

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
 * ATTEMPTS × ATTEMPT_TIMEOUT_MS + backoff, PLUS a cold `npm ci` and the
 * secret scan, must stay under the job's timeout-minutes. At 3 × 110s + 2 × 10s
 * that is ~5.8 minutes of audit + ~4.5 minutes of cold install against 18.
 *
 * 60s was itself below an already-observed normal-slow duration (#1520): the
 * PR that introduced the retry recorded ~155s for a single attempt against a
 * slow registry, so under that same condition all three 60s-bounded attempts
 * were killed before returning anything, and this REQUIRED, fail-closed check
 * blocked every merge for the duration of the registry incident with no way
 * to tell a slow registry from a real advisory in the log. 110s is the
 * largest bound that still leaves the job's checkout+install its own room
 * (see the retry-budget test below).
 */
const ATTEMPT_TIMEOUT_MS = 110_000;

function runAudit() {
  try {
    return execFileSync(
      'npm',
      ['audit', ...(ALL ? [] : ['--omit=dev']), '--json', '--fetch-timeout=45000', '--fetch-retries=1'],
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
  // Distinct, greppable wording (#1520): every attempt returning empty is the
  // timeout/registry-outage shape, not a parse failure or a real advisory —
  // an operator reading the log should be able to tell those apart without
  // opening the run.
  console.error(
    `audit-gate: could not reach the advisory endpoint after ${ATTEMPTS} bounded attempts ` +
      `(${ATTEMPT_TIMEOUT_MS / 1000}s each) — npm audit produced no output. This looks like a ` +
      `slow/unreachable registry, not a vulnerability finding.`
  );
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
  console.error(`audit-gate: ${ALL ? 'NOT ALLOW-LISTED advisories (all dependencies, non-blocking report)' : 'BLOCKING production advisories'}:`);
  for (const b of new Set(blocking)) console.error('  ' + b);
  process.exit(auditExitCode(verdict));
}
const usedIds = new Set(waived.map(w => w.split(' ')[2]));
for (const id of ALLOW.keys()) if (!usedIds.has(id)) console.log(`audit-gate: allow-list entry ${id} matched nothing: remove it (the advisory is gone).`);
console.log(`audit-gate: clean (${new Set(waived).size} documented waiver(s))`);
