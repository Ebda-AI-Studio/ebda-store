/** Split a migration file into single statements (comments stripped; no `;` inside literals in our migrations). */
export const statements = (sql: string): string[] =>
  sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
