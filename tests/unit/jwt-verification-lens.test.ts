import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LENS: "your AI read the claims without checking the envelope was sealed."
 *
 * The failure this guards against is not exotic. An AI-written auth layer
 * DECODES a JWT to read `role`, and never verifies the signature. A user
 * base64-decodes their own token, flips `member` to `admin`, re-encodes, and
 * the server grants every protected route — no alert, no log line. The same
 * shortcut also skips `exp` (a stolen token then works forever) and `iss`
 * (a token minted by a different tenant of the same auth provider is accepted).
 *
 * It passes review because it works perfectly for honest users. Only a
 * deliberately modified token reveals that the authorization layer is absent.
 *
 * This file is that lens as a GATE. A one-time audit finds today's instance;
 * a gate finds the one someone adds next month. Three rules:
 *
 *   1. Every `jwt.verify` pins `algorithms`.
 *   2. `ignoreExpiration` appears only where it is allowlisted below, with a
 *      reason — and never on a call that grants access.
 *   3. `jwt.decode` is never the basis of an auth decision.
 *
 * Rule 3 is enforced by review, not regex — decode is legitimate AFTER a
 * verify (re-extracting `jti` cheaply), and no regex separates that from the
 * dangerous case. What IS mechanised is the count: if a new decode appears,
 * this test fails and forces someone to look at it.
 */

const API_SRC = path.resolve(process.cwd(), 'apps/api/src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.isFile() && p.endsWith('.ts') && !p.includes('.test.') ? [p] : [];
  });
}

/**
 * Blank out comments and string/template contents, keeping every other
 * character (including newlines, for line-number stability) in place. Without
 * this, a `// algorithms: ['none']` comment or a `'issuer: none'` string
 * literal inside a `jwt.verify(...)` argument list satisfies the regexes
 * below on text a human never reads as configuration.
 */
function stripCommentsAndStrings(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < s.length && s[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Each `jwt.verify(...)` call with its full argument list. */
function verifyCalls(): { file: string; line: number; call: string; clean: string }[] {
  const out: { file: string; line: number; call: string; clean: string }[] = [];
  for (const file of sourceFiles(API_SRC)) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/jwt\.verify\s*\(/g)) {
      let depth = 0;
      let end = m.index!;
      for (let i = m.index!; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const call = src.slice(m.index!, end + 1);
      out.push({
        file: path.relative(process.cwd(), file),
        line: src.slice(0, m.index).split('\n').length,
        call,
        // Assertions below run against `clean`, never `call` — a comment or
        // string literal must not be able to satisfy them.
        clean: stripCommentsAndStrings(call),
      });
    }
  }
  return out;
}

/**
 * Where skipping `exp` is deliberate. Each entry must be a call that
 * establishes IDENTITY only — never one that authorises a request. The value
 * PINS THE EXACT COUNT of allowlisted calls in that file — membership alone
 * (a bare Set) lets a SECOND, unreviewed `ignoreExpiration: true` call ride
 * in on the same file's existing allowlisting, invisibly.
 */
const IGNORE_EXPIRATION_ALLOWED: Record<string, number> = {
  // CSRF principal: derives who a request belongs to so the CSRF token can be
  // bound to them. `authenticate` still enforces expiry before anything is
  // authorised; treating a just-expired cookie as anonymous here would turn a
  // silent-refresh 401 into a confusing 403.
  'apps/api/src/middleware/security.ts': 1,
};

describe('JWT lens — the envelope is checked before the claims are believed', () => {
  it('finds jwt.verify calls at all (the lens must not pass by finding nothing)', () => {
    // A parser that silently matches zero calls would make every assertion
    // below vacuously true — the classic gate that cannot fail.
    expect(verifyCalls().length).toBeGreaterThan(5);
  });

  it('pins `algorithms` on every jwt.verify', () => {
    const unpinned = verifyCalls()
      .filter(c => !/algorithms\s*:/.test(c.clean))
      .map(c => `${c.file}:${c.line}`);
    expect(unpinned).toEqual([]);
  });

  it('checks issuer and audience on every jwt.verify', () => {
    const missing = verifyCalls()
      .filter(c => !/issuer\s*:/.test(c.clean) || !/audience\s*:/.test(c.clean))
      .map(c => `${c.file}:${c.line}`);
    expect(missing).toEqual([]);
  });

  it('skips expiry only where allowlisted, at the exact reviewed count, and never silently', () => {
    const seen: Record<string, number> = {};
    for (const c of verifyCalls()) {
      if (!/ignoreExpiration\s*:\s*true/.test(c.clean)) continue;
      seen[c.file] = (seen[c.file] ?? 0) + 1;
      expect(
        c.file in IGNORE_EXPIRATION_ALLOWED,
        `${c.file}:${c.line} skips expiry without being allowlisted in this test`
      ).toBe(true);
    }
    // Whole-file membership lets a SECOND unreviewed call in an already
    // allowlisted file pass unnoticed — pin the count so it can't.
    expect(seen).toEqual(IGNORE_EXPIRATION_ALLOWED);
  });

  it('keeps jwt.decode rare enough that each use stays reviewed', () => {
    // Not a ban: decode after a successful verify is correct and cheap. This
    // pins the COUNT so a new one cannot slip in unnoticed — if this fails,
    // read the new call and decide whether a verify precedes it.
    // Counted PER FILE, not per line: pinning line numbers makes this fail on
    // any unrelated edit above the call, which trains people to re-baseline it
    // without reading — the opposite of the point.
    const decodes: Record<string, number> = {};
    for (const f of sourceFiles(API_SRC)) {
      const n = [...fs.readFileSync(f, 'utf-8').matchAll(/jwt\.decode\s*\(/g)].length;
      if (n > 0) decodes[path.relative(process.cwd(), f)] = n;
    }
    expect(decodes).toEqual({
      // Both re-extract `jti` from a token `jwt.verify` has already accepted.
      'apps/api/src/middleware/auth.ts': 2,
      // Reads `userId` from a token this process just minted itself.
      'apps/api/src/routes/auth.routes.ts': 1,
      // `apps/api/src/middleware/security.ts` was here: `refreshLimiterKey`
      // decoded `sub` off the PRESENTED refresh token to pick a rate-limit
      // bucket, on the argument that a bucket is not a capability. True for
      // capability, wrong for rate limiting — an unverified `sub` lets the
      // CALLER choose the partition, so N forged tokens buy N independent
      // budgets. It verifies now, and unverifiable tokens share `anon`.
    });
  });
});
