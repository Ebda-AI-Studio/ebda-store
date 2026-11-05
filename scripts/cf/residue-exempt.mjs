// The residue gate's exemption rules (NZ-17 category G), split out so a test can import them (decommission-neon.mjs parses argv at load).
/**
 * NZ-17 category G: prisma-lite, the RPC codec and the DO tests are live production code on the StoreDO. They NAME Prisma
 * (`Prisma.Decimal`, the DMMF types) and mention the Postgres twin's `pg_advisory` locks in comments, but run no Postgres.
 * Under these prefixes only those NAMING hits are exempt; HYPERDRIVE, DATABASE_URL, DIRECT_URL, NEON_, `$executeRaw`, a
 * `PrismaClient` import or a `pg_advisory` in code still count, and nothing outside these prefixes is exempt.
 */
export const RESIDUE_TYPE_ONLY = ['packages/repo/', 'apps/api/workers-do/'];
/** true when a `git grep -n` hit (`file:line:text`) in a RESIDUE_TYPE_ONLY path only names Prisma types or Postgres in prose */
export function isTypeOnlyHit(file, text) {
  if (!RESIDUE_TYPE_ONLY.some(p => file.startsWith(p))) return false;
  const t = text.trim();
  if (/^(\/\/|\*|\/\*)/.test(t)) return !/DATABASE_URL|DIRECT_URL|NEON_|HYPERDRIVE/.test(t); // a comment: prose
  const imp = t.match(
    /^import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s+from\s+'@prisma\/client';?$/
  );
  if (imp) return !/\bPrismaClient\b/.test(imp[1] ?? ''); // types + Prisma.Decimal, never the client
  if (/^"@prisma\/client":\s*"[^"]+",?$/.test(t)) return true; // the package.json dependency
  if (/expect\(\(\) => \w+\.\$queryRaw\)\.toThrow\(/.test(t)) return true; // asserts the DO client REFUSES raw SQL
  return false;
}
/** the files that still count after the exemptions; `hits` are `git grep -n` lines */
export function residueFilesOf(hits, exempt) {
  const files = new Set();
  for (const h of hits) {
    const m = h.match(/^([^:]+):\d+:(.*)$/);
    if (!m || exempt(m[1]) || isTypeOnlyHit(m[1], m[2])) continue;
    files.add(m[1]);
  }
  return [...files];
}
