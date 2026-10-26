/**
 * Identity stage 5 (contract phase). The admin namespace (merchant owner, staff, super admin) is authenticated by the identity
 * service's ES256 tokens only. A Store-signed HS256 token for such a role is a leftover from before the cutover (or forged with a
 * stolen secret) and proves nothing any more. Customers and impersonation tokens (`impersonatedBy`) stay HS256.
 */
export function isLegacyAdminToken(p: { role?: string; impersonatedBy?: string }): boolean {
  if (testsAllowLegacyAdminTokens()) return false;
  return !!p.role && p.role !== 'customer' && !p.impersonatedBy;
}

/**
 * TEST-ONLY seam (Ruling ID-20): about 30 integration and unit suites mint HS256 admin tokens to exercise routes behind the real
 * `authenticate`. They set EBDA_TEST_ALLOW_LEGACY_ADMIN_HS256=1 in tests/setup.ts, and it only counts when NODE_ENV is 'test'. A
 * deployed Worker never has NODE_ENV=test, so production has no switch. Migrating those suites to identity-service test tokens
 * removes this function; legacy-admin-hs256.test.ts proves the refusal with the seam off.
 */
function testsAllowLegacyAdminTokens(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV === 'test' &&
    process.env?.EBDA_TEST_ALLOW_LEGACY_ADMIN_HS256 === '1'
  );
}
