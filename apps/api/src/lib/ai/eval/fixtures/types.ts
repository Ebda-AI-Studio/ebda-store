import type { AiOutputType } from '../types';

/** A realistic (input, output) pair that MUST pass every deterministic check for its type. */
export interface GoldenCase<TInput = any, TOutput = any> {
  id: string;
  type: AiOutputType;
  input: TInput;
  output: TOutput;
}

/**
 * A real or realistic regression case that MUST fail at least one
 * deterministic check. `expectedFailedChecks` names the check(s) it
 * should trip — the generic test loop asserts every one of them appears
 * in the failed-check list, so a fixture can't silently stop testing
 * anything if a check is later renamed/removed.
 *
 * To add a new real-world failure: drop a new file in this directory
 * exporting one `KnownFailureCase`, then add one import + array entry in
 * `known-failures/index.ts`.
 */
export interface KnownFailureCase<TInput = any, TOutput = any> extends GoldenCase<TInput, TOutput> {
  /** What real (or realistic) defect this reproduces. */
  description: string;
  expectedFailedChecks: string[];
}
