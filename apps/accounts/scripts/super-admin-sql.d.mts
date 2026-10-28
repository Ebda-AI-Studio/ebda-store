export function parseArgs(argv: string[]): {
  apply: boolean;
  email: string;
  firstName: string;
  lastName: string;
  resetFactors: boolean;
  remote?: boolean;
  local?: boolean;
};
export function passwordProblem(p: string): string | null;
export function lookupSql(email: string): string;
export function decide(
  existing: Record<string, unknown> | null,
  resetFactors: boolean
): { clearFactors: boolean; issueToken: boolean };
export function describePlan(
  existing: Record<string, unknown> | null,
  email: string,
  resetFactors?: boolean
): string[];
export const ENROLMENT_TOKEN_TTL_MS: number;
export function buildUpsertSql(input: {
  existingId: string | null;
  newId: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  nowIso: string;
  nowMs: number;
  clearFactors?: boolean;
  tokenHash?: string | null;
  tokenId?: string | null;
}): string[];
