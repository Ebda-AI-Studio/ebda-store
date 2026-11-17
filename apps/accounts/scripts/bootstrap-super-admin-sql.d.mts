export const NO_PASSWORD: string;
export interface BootstrapArgs {
  apply: boolean;
  allowAdditional: boolean;
  resendEmail: boolean;
  issueEnrolmentToken: boolean;
  email: string;
  firstName: string;
  lastName: string;
  remote: boolean;
  local: boolean;
}
export interface BootstrapTarget {
  id: string;
  role: string;
  status: string;
  emailVerified: boolean;
  noPassword: boolean;
  hasFactor: boolean;
}
export interface BootstrapState {
  otherAdmins: number;
  target: BootstrapTarget | null;
}
export function parseBootstrapArgs(argv: string[]): BootstrapArgs;
export function stateSql(email: string): string;
export function readState(row: Record<string, unknown> | null | undefined): BootstrapState;
export function planBootstrap(
  state: BootstrapState,
  args: Pick<BootstrapArgs, 'allowAdditional' | 'resendEmail' | 'issueEnrolmentToken'>
): { action: 'create' | 'refuse' | 'noop' | 'resend' | 'issue-token'; reason?: string };
export function buildBootstrapSql(input: {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  actor: string;
  nowMs: number;
  allowAdditional?: boolean;
}): string[];
export function buildIssueTokenSql(input: {
  userId: string;
  email: string;
  actor: string;
  nowMs: number;
  tokenId: string;
  tokenHash: string;
}): string[];
export function resetIssuedSql(userId: string, sinceIso: string): string;
export function actorName(raw: unknown): string;
