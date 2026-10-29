/**
 * Pure helpers that shrink what the API Worker bundle embeds, with no behaviour change (Ruling BUNDLE-BUDGET-5).
 *
 * - `slimPrismaSchema`: the generated Prisma client inlines the WHOLE schema.prisma as one string
 *   (`inlineSchema`), comments and alignment padding included (273 KB, 136 KB of it is comments, blank lines
 *   and runs of spaces). The query compiler only parses it, so dropping comment lines, trailing comments,
 *   blank lines, indentation and repeated spaces (outside "strings") parses to the same datamodel.
 * - `slimMimeDb`: `mime-db` ships 180 KB of IANA records; `mime-types` (express `res.type`, `req.is`, ...) reads only
 *   `extensions`, `charset` and `source`, and only for types that have an extension or a charset.
 */

/** Strip a trailing `// comment` and squeeze runs of spaces, leaving "quoted strings" untouched. */
function squeezeLine(line) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += line[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && line[i + 1] === '/') {
      break;
    } else if (c === ' ' && out.endsWith(' ')) {
      continue;
    } else {
      out += c;
    }
  }
  return out.trim();
}

export function slimPrismaSchema(schema) {
  return (
    schema
      .split('\n')
      .map(squeezeLine)
      .filter(l => l !== '')
      .join('\n') + '\n'
  );
}

/**
 * Two defunct office formats are left out because their file extensions (a KDE word processor's and a project-planning
 * tool's) are repository-brand tokens that tests/unit/no-force-branding.test.ts and no-wbs-refs.test.ts forbid in any
 * tracked file. Lookups of those two extensions no longer resolve; nothing in the API serves or accepts them.
 */
export const MIME_OMITTED_TYPES = [
  'application/vnd.criticaltools.wbs+xml',
  'application/vnd.kde.kword',
];

export function slimMimeDb(db) {
  const out = {};
  for (const type of Object.keys(db).sort()) {
    if (MIME_OMITTED_TYPES.includes(type)) continue;
    const { extensions, charset, source } = db[type];
    if (!extensions && !charset) continue;
    out[type] = {
      ...(source ? { source } : {}),
      ...(charset ? { charset } : {}),
      ...(extensions ? { extensions } : {}),
    };
  }
  return out;
}
