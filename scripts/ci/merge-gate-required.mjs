#!/usr/bin/env node
// Thin wrapper (F10): the required-check derivation is vendored from the foundation as scripts/foundation/merge-gate-required.mjs; never edit that
// copy. Re-exported so the Store's tests and tooling keep importing it from here; run directly it prints the same JSON array.
import { requiredChecks } from '../foundation/merge-gate-required.mjs';

export { parseWorkflow, requiredChecks } from '../foundation/merge-gate-required.mjs';

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log(JSON.stringify(requiredChecks(process.argv[2] ?? '.github/workflows')));
}
