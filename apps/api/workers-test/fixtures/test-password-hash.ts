/** Shared test fixture: the one bcrypt hash the workerd tests seed accounts with. */
export const TEST_PASSWORD = 'Passw0rd!xyz';
// bcrypt cost 4 of TEST_PASSWORD, a public test string and not a credential (fixtures only, never a real account).
// nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash -- test fixture hash of a public test password
export const TEST_PASSWORD_HASH = '$2b$04$jYDlZaJj/X/kmBmzPXDwsOP4.aIZ2IBm.rDUDGyiC8iKKUZPb/Rzm';
