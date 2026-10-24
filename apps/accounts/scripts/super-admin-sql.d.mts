export function parseArgs(argv: string[]): {
  apply: boolean;
  email: string;
  firstName: string;
  lastName: string;
  remote?: boolean;
  local?: boolean;
};
export function passwordProblem(p: string): string | null;
export function lookupSql(email: string): string;
export function describePlan(existing: Record<string, unknown> | null, email: string): string[];
export function buildUpsertSql(input: {
  existingId: string | null;
  newId: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  nowIso: string;
  nowMs: number;
}): string[];
