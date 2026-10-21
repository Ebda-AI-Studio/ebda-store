# Ebda Store — TOTP 2FA + Access-Token Revocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TOTP-based two-factor auth (super-admin mandatory, store-admin optional) and a server-side revocation path for the existing 30-day access token — WITHOUT shortening token lifetime.

**Architecture:** Keep the 30-day access token UX. Add a `jti` claim + Redis denylist (kill one session) and a `tokenVersion` claim compared against the user row via a Redis cache (kill all sessions). TOTP secret stored with the existing `EncryptionService` (AES-256-GCM, `ENCRYPTION_KEY`). MFA enforced for `super_admin` via a gate middleware; `store_admin` opt-in. Backup codes + a CLI reset script guarantee no permanent lockout.

**Tech Stack:** Express + TypeScript, Prisma + Neon Postgres, Redis (ioredis), `otplib` (TOTP), `qrcode` (enrollment QR), Next.js admin (`apps/admin`), Vitest integration tests.

**Key existing integration points (verbatim from recon):**

- JWT sign: `apps/api/src/services/auth.service.ts` `generateTokens()` (~L953-1001), HS256, `config.jwtSecret`, `config.jwtExpiresIn` (`'30d'`).
- Auth middleware: `apps/api/src/middleware/auth.ts` `authenticate()` (L47-72) — claims-only, no DB read today.
- Login: `apps/api/src/routes/auth.routes.ts` `POST /login` (L196-244) → `AuthService.login()` (L392-462); `setTokenCookie()`.
- Encryption: `apps/api/src/services/encryption.service.ts` → `encryption.encrypt()/.decrypt()` (singleton, `ENCRYPTION_KEY`).
- Redis: `apps/api/src/services/redis.service.ts` → `redis` singleton, `redis.getClient()` (`Redis|null`), `redis.isAvailable()`.
- Rate limit: `apps/api/src/middleware/security.ts` → `authLimiter`, `makeRateLimitStore(redis.getClient(), '<prefix>')`.
- Migrations: `npm run db:migrate` (`prisma migrate dev`), schema at `packages/database/prisma/schema.prisma` (User L24-93, `UserRole {customer, store_admin, super_admin}`). DDL needs `DIRECT_URL`.
- Tests: `tests/integration/*.test.ts` (Vitest, API at `http://localhost:4000/api/v1`, create user via `prisma.user.create` + HTTP login, cleanup via targeted delete in `afterAll`).

---

## Task 1: Schema — MFA columns + tokenVersion

**Files:**

- Modify: `packages/database/prisma/schema.prisma:24-93` (User model)
- Create: `packages/database/prisma/migrations/<ts>_add_mfa_and_token_version/migration.sql` (generated)

- [ ] **Step 1: Add fields to the User model** (all additive + defaulted → forward-compatible per the migrate-ordering rule)

```prisma
  // ── 2FA / MFA ──
  mfaEnabled     Boolean   @default(false) @map("mfa_enabled")
  mfaSecret      String?   @map("mfa_secret")          // AES-256-GCM encrypted TOTP secret
  mfaBackupCodes String[]  @default([]) @map("mfa_backup_codes") // bcrypt-hashed one-time codes
  mfaEnrolledAt  DateTime? @map("mfa_enrolled_at")
  // ── session revocation ──
  tokenVersion   Int       @default(0) @map("token_version")
```

- [ ] **Step 2: Generate the migration**

Run: `cd packages/database && DIRECT_URL="$DIRECT_URL" npx prisma migrate dev --name add_mfa_and_token_version`
Expected: new migration dir created, `migration.sql` contains `ALTER TABLE "users" ADD COLUMN ...` for 5 columns, all `NOT NULL DEFAULT` or nullable. Verify NO column is `NOT NULL` without a default.

- [ ] **Step 3: Regenerate client + clear stale tsc cache** (per the prisma-stale-types rule)

Run: `npx prisma generate && rm -f ../../tsconfig.tsbuildinfo && cd ../.. && npm run typecheck`
Expected: PASS (no "Property 'mfaEnabled' does not exist" errors).

- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations
git commit -m "feat(db): add MFA columns + tokenVersion to User"
```

---

## Task 2: Dependencies — otplib + qrcode

**Files:**

- Modify: `apps/api/package.json`

- [ ] **Step 1: Install** (registry-clean, actively maintained — dep-discipline rule)

Run: `cd apps/api && npm install otplib@^12 qrcode@^1.5 && npm install -D @types/qrcode`
Expected: added to dependencies; `otplib` has no native deps.

- [ ] **Step 2: Audit gate**

Run: `npm audit --audit-level=low --omit=dev`
Expected: 0 vulnerabilities. If any, stop and resolve before continuing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json ../../package-lock.json
git commit -m "chore(api): add otplib + qrcode for TOTP"
```

---

## Task 3: MFA service (pure logic, TDD)

**Files:**

- Create: `apps/api/src/services/mfa.service.ts`
- Test: `apps/api/tests/unit/mfa.service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { MfaService } from '../../src/services/mfa.service';
import { authenticator } from 'otplib';

describe('MfaService', () => {
  it('generates a secret and an otpauth url for the account', () => {
    const { secret, otpauthUrl } = MfaService.generateEnrollment('admin@store.test');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/); // base32
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(otpauthUrl).toContain('admin%40store.test');
  });

  it('verifies a code produced from the secret', () => {
    const { secret } = MfaService.generateEnrollment('a@b.test');
    const code = authenticator.generate(secret);
    expect(MfaService.verifyCode(secret, code)).toBe(true);
    expect(MfaService.verifyCode(secret, '000000')).toBe(false);
  });

  it('generates 10 backup codes and verifies one-time consumption', async () => {
    const { plain, hashed } = await MfaService.generateBackupCodes();
    expect(plain).toHaveLength(10);
    expect(hashed).toHaveLength(10);
    const { matched, remaining } = await MfaService.consumeBackupCode(hashed, plain[3]);
    expect(matched).toBe(true);
    expect(remaining).toHaveLength(9);
    const again = await MfaService.consumeBackupCode(remaining, plain[3]);
    expect(again.matched).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/api && npx vitest run tests/unit/mfa.service.test.ts`
Expected: FAIL — cannot find module `mfa.service`.

- [ ] **Step 3: Implement the service**

```typescript
// apps/api/src/services/mfa.service.ts
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const ISSUER = 'Ebda Store';

export class MfaService {
  static generateEnrollment(accountLabel: string): { secret: string; otpauthUrl: string } {
    const secret = authenticator.generateSecret(); // base32
    const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
    return { secret, otpauthUrl };
  }

  static async qrDataUrl(otpauthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpauthUrl);
  }

  static verifyCode(secret: string, token: string): boolean {
    if (!/^\d{6}$/.test(token ?? '')) return false;
    // window:1 tolerates ±30s clock skew
    return authenticator.verify({ token, secret, window: 1 } as any);
  }

  static async generateBackupCodes(count = 10): Promise<{ plain: string[]; hashed: string[] }> {
    const plain = Array.from(
      { length: count },
      () => crypto.randomBytes(5).toString('hex') // 10 hex chars
    );
    const hashed = await Promise.all(plain.map(c => bcrypt.hash(c, 10)));
    return { plain, hashed };
  }

  static async consumeBackupCode(
    hashed: string[],
    candidate: string
  ): Promise<{ matched: boolean; remaining: string[] }> {
    for (let i = 0; i < hashed.length; i++) {
      if (await bcrypt.compare(candidate ?? '', hashed[i])) {
        const remaining = hashed.filter((_, idx) => idx !== i);
        return { matched: true, remaining };
      }
    }
    return { matched: false, remaining: hashed };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/unit/mfa.service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/mfa.service.ts apps/api/tests/unit/mfa.service.test.ts
git commit -m "feat(api): MFA service — TOTP + backup codes"
```

---

## Task 4: Redis revocation helpers (jti denylist + tokenVersion cache)

**Files:**

- Modify: `apps/api/src/services/redis.service.ts`
- Test: `apps/api/tests/unit/redis-revocation.test.ts`

- [ ] **Step 1: Write the failing test** (uses the in-memory fallback path when Redis is down)

```typescript
import { describe, it, expect } from 'vitest';
import { redis } from '../../src/services/redis.service';

describe('redis revocation helpers', () => {
  it('denies a jti and reports it denied', async () => {
    await redis.denyJti('jti-abc', 60);
    expect(await redis.isJtiDenied('jti-abc')).toBe(true);
    expect(await redis.isJtiDenied('jti-never')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/unit/redis-revocation.test.ts`
Expected: FAIL — `redis.denyJti is not a function`.

- [ ] **Step 3: Add the helpers to RedisService** (fail-open on outage — never lock users out)

```typescript
  // --- session revocation ---
  async denyJti(jti: string, ttlSeconds: number): Promise<void> {
    const c = this.getClient();
    if (!c) return; // fail-open: Redis down → cannot deny, accept residual risk
    await c.setex(`jti:deny:${jti}`, Math.max(1, Math.ceil(ttlSeconds)), '1');
  }

  async isJtiDenied(jti: string): Promise<boolean> {
    const c = this.getClient();
    if (!c) return false; // fail-open
    return (await c.exists(`jti:deny:${jti}`)) === 1;
  }

  async setUserTokenVersion(userId: string, version: number): Promise<void> {
    const c = this.getClient();
    if (!c) return;
    await c.set(`user:tv:${userId}`, String(version));
  }

  async getUserTokenVersion(userId: string): Promise<number | null> {
    const c = this.getClient();
    if (!c) return null;
    const v = await c.get(`user:tv:${userId}`);
    return v === null ? null : Number(v);
  }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/unit/redis-revocation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/redis.service.ts apps/api/tests/unit/redis-revocation.test.ts
git commit -m "feat(api): Redis helpers for jti denylist + tokenVersion cache"
```

---

## Task 5: Stamp jti + tv on the access token

**Files:**

- Modify: `apps/api/src/services/auth.service.ts:953-1001` (`generateTokens`) + `TokenPayload` (L11-17)

- [ ] **Step 1: Extend TokenPayload**

```typescript
interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
  tv?: number; // tokenVersion
}
```

- [ ] **Step 2: Add `jwtid` + `tv` to the access-token sign call** (keep `expiresIn` = 30d unchanged)

```typescript
const accessJti = crypto.randomUUID();
const accessToken = jwt.sign({ ...payload, tv: payload.tv ?? 0 }, config.jwtSecret, {
  algorithm: 'HS256',
  expiresIn: config.jwtExpiresIn as any, // unchanged — 30d
  issuer: 'ebda-api',
  audience: 'ebda-app',
  subject: payload.userId,
  jwtid: accessJti,
});
```

- [ ] **Step 3: Ensure callers pass `tv`** — in `AuthService.login` where `generateTokens` is called, include `tv: user.tokenVersion` in the payload (the user row is already loaded at L392-462).

```typescript
const tokens = this.generateTokens({
  userId: user.id,
  email: user.email,
  role: user.role,
  storeId: user.storeId,
  tv: user.tokenVersion,
});
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd ../.. && npm run typecheck`
Expected: PASS.

```bash
git add apps/api/src/services/auth.service.ts
git commit -m "feat(api): embed jti + tokenVersion in access token"
```

---

## Task 6: Enforce revocation in the auth middleware

**Files:**

- Modify: `apps/api/src/middleware/auth.ts:47-72` (`authenticate`)
- Test: `tests/integration/token-revocation.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';

const API = `${process.env.API_HOST || 'http://localhost:4000'}/api/v1`;
const PW = 'Test1234!pw';
const EMAIL = `revoke-${Date.now()}@example.test`;

async function loginAdmin() {
  await prisma.user.create({
    data: {
      email: EMAIL,
      passwordHash: await bcrypt.hash(PW, 10),
      firstName: 'Rev',
      lastName: 'Oke',
      role: 'super_admin',
      emailVerified: true,
      storeId: null,
    },
  });
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  return (await r.json()).data.accessToken as string;
}

describe('access-token revocation', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
  });

  it('rejects a token after logout (jti denylist)', async () => {
    const token = await loginAdmin();
    const ok = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    await fetch(`${API}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    const after = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/integration/token-revocation.test.ts` (API running)
Expected: FAIL — second `/auth/me` returns 200 (no denylist yet).

- [ ] **Step 3: Add denylist + tokenVersion checks to `authenticate`** (after the existing `jwt.verify`, before `req.user = payload`)

```typescript
const payload = jwt.verify(token, config.jwtSecret, {
  algorithms: ['HS256'],
  issuer: 'ebda-api',
  audience: 'ebda-app',
}) as AuthPayload & { type?: string; tv?: number; jti?: string };

if (payload.type === 'refresh') {
  throw new AppError(401, 'TOKEN_INVALID', 'Refresh tokens cannot be used for authentication');
}

// revocation: single-session (jti denylist)
const decoded = jwt.decode(token) as { jti?: string } | null;
if (decoded?.jti && (await redis.isJtiDenied(decoded.jti))) {
  throw new AppError(401, 'TOKEN_REVOKED', 'Session has been revoked');
}

// revocation: kill-all (tokenVersion). Redis-cached; lazily backfilled from DB.
let currentTv = await redis.getUserTokenVersion(payload.userId);
if (currentTv === null) {
  const u = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { tokenVersion: true },
  });
  currentTv = u?.tokenVersion ?? 0;
  await redis.setUserTokenVersion(payload.userId, currentTv);
}
if ((payload.tv ?? 0) < currentTv) {
  throw new AppError(401, 'TOKEN_REVOKED', 'Session has been revoked');
}

(req as any).tokenJti = decoded?.jti;
req.user = payload;
next();
```

Add imports at top: `import { redis } from '../services/redis.service';` and `import { prisma } from '@ebda/database';` (match the repo's import alias).

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/integration/token-revocation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts tests/integration/token-revocation.test.ts
git commit -m "feat(api): enforce jti denylist + tokenVersion in auth middleware"
```

---

## Task 7: Wire logout → denylist + add logout-all → tokenVersion bump

**Files:**

- Modify: `apps/api/src/routes/auth.routes.ts:277-295` (logout) + `apps/api/src/services/auth.service.ts` (add `revokeAllSessions`)

- [ ] **Step 1: In `POST /logout`, deny the current access-token jti** (compute remaining TTL from `exp`)

```typescript
router.post('/logout', authenticate, async (req, res, next) => {
  const { refreshToken } = req.body;
  if (refreshToken) await AuthService.logout(refreshToken);
  const jti = (req as any).tokenJti as string | undefined;
  const exp = (req.user as any)?.exp as number | undefined; // jwt sets exp (seconds)
  if (jti) {
    const ttl = exp ? exp - Math.floor(Date.now() / 1000) : 60;
    await redis.denyJti(jti, Math.max(1, ttl));
  }
  clearTokenCookie(res);
  res.json({ success: true, data: { message: 'Logged out successfully' } });
});
```

Note: `authenticate` now required on logout so we have the jti. Import `redis`.

- [ ] **Step 2: Add `AuthService.revokeAllSessions(userId)`** — bump tokenVersion in DB + Redis

```typescript
static async revokeAllSessions(userId: string): Promise<void> {
  const u = await prisma.user.update({
    where: { id: userId }, data: { tokenVersion: { increment: 1 } }, select: { tokenVersion: true },
  });
  await redis.setUserTokenVersion(userId, u.tokenVersion);
  await prisma.refreshToken.updateMany({
    where: { /* user relation */ revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'revoke_all' },
  }); // match existing refreshToken schema's user FK field name
}
```

- [ ] **Step 3: Add `POST /logout-all` route** (authenticated)

```typescript
router.post('/logout-all', authenticate, async (req, res, next) => {
  await AuthService.revokeAllSessions(req.user!.userId);
  clearTokenCookie(res);
  res.json({ success: true, data: { message: 'All sessions revoked' } });
});
```

- [ ] **Step 4: Bump tokenVersion on password change** — in the existing change-password handler, call `await AuthService.revokeAllSessions(userId)` after the hash update so old tokens die.

- [ ] **Step 5: Typecheck, run revocation test, commit**

Run: `cd ../.. && npm run typecheck && cd apps/api && npx vitest run tests/integration/token-revocation.test.ts`
Expected: PASS.

```bash
git add apps/api/src/routes/auth.routes.ts apps/api/src/services/auth.service.ts
git commit -m "feat(api): logout denylists jti; logout-all + password-change bump tokenVersion"
```

---

## Task 8: MFA login branch + enrollment/verify/disable routes

**Files:**

- Modify: `apps/api/src/services/auth.service.ts` (`login` returns MFA challenge when enabled)
- Create: `apps/api/src/routes/mfa.routes.ts`
- Modify: `apps/api/src/index.ts` (mount `/auth/mfa`)
- Test: `tests/integration/mfa.test.ts`

- [ ] **Step 1: Write the failing integration test** (enroll → login requires 2nd factor → verify → session)

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@ebda/database';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';

const API = `${process.env.API_HOST || 'http://localhost:4000'}/api/v1`;
const PW = 'Test1234!pw';
const EMAIL = `mfa-${Date.now()}@example.test`;

describe('MFA enroll + login', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } });
  });

  it('enrolls then requires the TOTP code at login', async () => {
    await prisma.user.create({
      data: {
        email: EMAIL,
        passwordHash: await bcrypt.hash(PW, 10),
        firstName: 'M',
        lastName: 'F',
        role: 'super_admin',
        emailVerified: true,
        storeId: null,
      },
    });
    let token = (
      await (
        await fetch(`${API}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: EMAIL, password: PW }),
        })
      ).json()
    ).data.accessToken;

    const begin = await (
      await fetch(`${API}/auth/mfa/enroll/begin`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    expect(begin.data.secret).toBeTruthy();

    const code = authenticator.generate(begin.data.secret);
    const done = await fetch(`${API}/auth/mfa/enroll/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code }),
    });
    expect(done.status).toBe(200);

    const login2 = await (
      await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PW }),
      })
    ).json();
    expect(login2.data.mfaRequired).toBe(true);
    expect(login2.data.accessToken).toBeUndefined();

    const code2 = authenticator.generate(begin.data.secret);
    const verify = await (
      await fetch(`${API}/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: login2.data.challengeToken, code: code2 }),
      })
    ).json();
    expect(verify.data.accessToken).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/integration/mfa.test.ts`
Expected: FAIL — `/auth/mfa/enroll/begin` 404.

- [ ] **Step 3: Make `AuthService.login` return a challenge when `mfaEnabled`**

In `login()` after a successful password check, before issuing tokens:

```typescript
if (user.mfaEnabled) {
  const challengeToken = jwt.sign({ userId: user.id, purpose: 'mfa' }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '5m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });
  return { mfaRequired: true, challengeToken } as any;
}
```

- [ ] **Step 4: Create `mfa.routes.ts`** (begin/verify-enroll/verify-login/disable; rate-limited)

```typescript
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/security';
import { prisma } from '@ebda/database';
import { encryption } from '../services/encryption.service';
import { MfaService } from '../services/mfa.service';
import { AuthService } from '../services/auth.service';
import { config } from '../config';
import { AppError } from '../lib/errors';

const router = Router();

// begin: generate + store encrypted secret (not yet enabled), return QR
router.post('/enroll/begin', authenticate, async (req, res) => {
  const { secret, otpauthUrl } = MfaService.generateEnrollment(req.user!.email);
  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { mfaSecret: encryption.encrypt(secret) },
  });
  res.json({ success: true, data: { secret, qr: await MfaService.qrDataUrl(otpauthUrl) } });
});

// verify enroll: confirm a code, enable, return one-time backup codes
router.post('/enroll/verify', authenticate, authLimiter, async (req, res) => {
  const { code } = req.body;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { mfaSecret: true },
  });
  if (!u?.mfaSecret) throw new AppError(400, 'MFA_NOT_STARTED', 'Begin enrollment first');
  if (!MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code))
    throw new AppError(400, 'MFA_BAD_CODE', 'Invalid code');
  const { plain, hashed } = await MfaService.generateBackupCodes();
  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { mfaEnabled: true, mfaEnrolledAt: new Date(), mfaBackupCodes: hashed },
  });
  res.json({ success: true, data: { backupCodes: plain } });
});

// verify login: exchange challengeToken + code for a real session
router.post('/verify', authLimiter, async (req, res) => {
  const { challengeToken, code } = req.body;
  let payload: any;
  try {
    payload = jwt.verify(challengeToken, config.jwtSecret, {
      issuer: 'ebda-api',
      audience: 'ebda-app',
    });
  } catch {
    throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'Challenge expired');
  }
  if (payload.purpose !== 'mfa') throw new AppError(401, 'MFA_CHALLENGE_INVALID', 'Bad challenge');
  const u = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!u?.mfaSecret) throw new AppError(400, 'MFA_NOT_ENABLED', 'MFA not enabled');

  let ok = MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code);
  if (!ok) {
    // try backup code
    const r = await MfaService.consumeBackupCode(u.mfaBackupCodes, code);
    if (r.matched) {
      ok = true;
      await prisma.user.update({ where: { id: u.id }, data: { mfaBackupCodes: r.remaining } });
    }
  }
  if (!ok) throw new AppError(401, 'MFA_BAD_CODE', 'Invalid code');

  const result = await AuthService.issueSessionFor(u); // see Step 5
  res.json({ success: true, data: result });
});

// disable: require a current code, then bump tokenVersion (kills sessions)
router.post('/disable', authenticate, authLimiter, async (req, res) => {
  const { code } = req.body;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { mfaSecret: true },
  });
  if (!u?.mfaSecret || !MfaService.verifyCode(encryption.decrypt(u.mfaSecret), code))
    throw new AppError(400, 'MFA_BAD_CODE', 'Invalid code');
  await prisma.user.update({
    where: { id: req.user!.userId },
    data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [], mfaEnrolledAt: null },
  });
  await AuthService.revokeAllSessions(req.user!.userId);
  res.json({ success: true, data: { message: 'MFA disabled' } });
});

export default router;
```

- [ ] **Step 5: Add `AuthService.issueSessionFor(user)`** — extracts the existing token-issue + cookie logic so MFA-verify can reuse it (return shape identical to a normal login: `{ user, accessToken, refreshToken }`). Refactor `login`'s tail to call it.

- [ ] **Step 6: Mount the router** in `apps/api/src/index.ts`: `app.use('/api/v1/auth/mfa', mfaRouter);` (after auth routes, before any catch-all).

- [ ] **Step 7: Run tests, verify pass**

Run: `npx vitest run tests/integration/mfa.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/mfa.routes.ts apps/api/src/services/auth.service.ts apps/api/src/index.ts tests/integration/mfa.test.ts
git commit -m "feat(api): TOTP enroll/verify/disable + MFA login challenge"
```

---

## Task 9: Super-admin enforcement gate

**Files:**

- Create: `apps/api/src/middleware/require-mfa.ts`
- Modify: route registration so admin/super-admin write routes pass through it (NOT the mfa enroll routes or auth routes)
- Test: `tests/integration/mfa-enforcement.test.ts`

- [ ] **Step 1: Write the failing test** — a `super_admin` with `mfaEnabled=false` hitting a protected route gets `403 MFA_SETUP_REQUIRED`.

```typescript
// create super_admin (mfaEnabled defaults false), login, GET a protected admin route → expect 403 MFA_SETUP_REQUIRED
```

- [ ] **Step 2: Run it, verify it fails** (currently 200).

- [ ] **Step 3: Implement the gate**

```typescript
// apps/api/src/middleware/require-mfa.ts
import { Request, Response, NextFunction } from 'express';
import { prisma } from '@ebda/database';
import { AppError } from '../lib/errors';

export async function requireMfaEnrolled(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'super_admin') return next(); // store_admin opt-in
  const u = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { mfaEnabled: true },
  });
  if (!u?.mfaEnabled)
    throw new AppError(403, 'MFA_SETUP_REQUIRED', 'Super-admin must enable two-factor auth');
  next();
}
```

- [ ] **Step 4: Apply** after `authenticate` on the protected admin router(s). Exempt: `/auth/*`, `/auth/mfa/*`, `/auth/me` (so they can reach enrollment + read self).

- [ ] **Step 5: Run tests, verify pass. Commit.**

```bash
git add apps/api/src/middleware/require-mfa.ts tests/integration/mfa-enforcement.test.ts
git commit -m "feat(api): enforce MFA enrollment for super_admin"
```

---

## Task 10: Anti-lockout CLI reset

**Files:**

- Create: `scripts/mfa-reset.ts`
- Modify: `docs/runbooks/` (new `mfa-recovery.md`)

- [ ] **Step 1: Implement the script** (run with DB access; disables MFA for an email so a locked-out admin recovers)

```typescript
// scripts/mfa-reset.ts — usage: DIRECT_URL=... npx tsx scripts/mfa-reset.ts <email>
import { prisma } from '@ebda/database';
(async () => {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: mfa-reset.ts <email>');
    process.exit(1);
  }
  const u = await prisma.user.updateMany({
    where: { email },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
      mfaBackupCodes: [],
      mfaEnrolledAt: null,
      tokenVersion: { increment: 1 },
    },
  });
  console.log(`MFA reset for ${email}: ${u.count} row(s)`);
  process.exit(0);
})();
```

- [ ] **Step 2: Write `docs/runbooks/mfa-recovery.md`** — when an admin loses their authenticator: (1) use a backup code; (2) if none, another super-admin disables via `/auth/mfa` after their own re-auth; (3) last resort `mfa-reset.ts` with prod `DIRECT_URL`. Document the tokenVersion bump (forces re-login everywhere).

- [ ] **Step 3: Commit**

```bash
git add scripts/mfa-reset.ts docs/runbooks/mfa-recovery.md
git commit -m "feat: MFA recovery CLI + runbook"
```

---

## Task 11: Admin UI — enrollment page + login second-factor step

**Files:**

- Create: `apps/admin/src/app/account/security/page.tsx`
- Modify: `apps/admin/src/app/login/page.tsx` + `apps/admin/src/lib/auth.tsx`

- [ ] **Step 1: Login flow** — in `auth.tsx` `login()`, if the response has `data.mfaRequired`, store `challengeToken` and route to a code-entry step; on submit, `POST /auth/mfa/verify` and proceed with the returned tokens exactly as a normal login.

```typescript
const res = await api.post('/auth/login', { email, password });
if (res.data.mfaRequired) {
  setChallenge(res.data.challengeToken);
  return { mfa: true };
}
// ...existing token storage...
```

- [ ] **Step 2: Security page** — `account/security/page.tsx`: "Enable 2FA" → `POST /auth/mfa/enroll/begin` → render `data.qr` (`<img src={qr}/>`) + manual `data.secret` → input for the 6-digit code → `POST /auth/mfa/enroll/verify` → display the returned backup codes once with a "copy / I saved these" confirm. Show a "Disable 2FA" action (asks for a current code → `POST /auth/mfa/disable`). For `super_admin`, show a banner if not yet enrolled.

- [ ] **Step 3: Manual verification** (no automated admin E2E in this plan):
  - Run admin app, log in as a super_admin → confirm forced-enrollment banner.
  - Enroll with a real authenticator app → save backup codes.
  - Log out, log in → confirm the code step appears → enter code → in.
  - "Log out all" / change password → confirm other sessions die.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/app/account/security/page.tsx apps/admin/src/app/login/page.tsx apps/admin/src/lib/auth.tsx
git commit -m "feat(admin): 2FA enrollment page + login second-factor step"
```

---

## Task 12: Docs + memory parity

**Files:**

- Modify: `DEPLOYMENT.md` (new env? none required — reuses `ENCRYPTION_KEY` + `REDIS_URL`), `SECURITY.md`/security baseline, `docs/uat/` (add `mfa.md` checklist)
- Modify: scoped memory + the global gap doc

- [ ] **Step 1: UAT checklist** `docs/uat/mfa.md` — golden path (enroll, login w/ code, backup code, disable) + edge cases (wrong code lockout via rate limit, lost authenticator recovery, Redis-down fail-open behavior).
- [ ] **Step 2: Update `~/.claude/.../reference-ebda-production-grade-standard.md`** — flip Ebda Store Layer 2 toward HAVE once shipped; move gap #1 (MFA) + #2 (revocation) to "closed for Ebda Store".
- [ ] **Step 3: Commit**

```bash
git add DEPLOYMENT.md docs/uat/mfa.md
git commit -m "docs: MFA UAT checklist + deployment notes"
```

---

## Rollout notes (read before deploy)

- **No env changes** — reuses `ENCRYPTION_KEY` (TOTP secret) + `REDIS_URL` (denylist). Confirm both set in prod.
- **No forced logout on deploy** — tokenVersion defaults 0; existing tokens have no `tv` claim → treated as `tv=0`, still valid. Login UX unchanged (still 30 days).
- **Enforce super-admin gate AFTER you've enrolled yourself** — deploy with the gate, then immediately enroll your own super-admin via the new page using a backup-code-safe flow, or you'll 403 yourself. Safer: ship Tasks 1-8 + 10-11 first (enrollment available), enroll, THEN ship Task 9 (enforcement).
- **Redis-down behavior is fail-open** (revocation bypassed during a Redis outage) — documented tradeoff to avoid locking everyone out; pair with the existing Redis uptime alert.

## Self-review notes

- Spec coverage: MFA TOTP ✓ (T3,8), super-admin mandatory/store-admin optional ✓ (T9), backup codes ✓ (T3,8), anti-lockout ✓ (T10), 30-day token kept ✓ (T5 expiry unchanged), jti denylist ✓ (T4,6,7), tokenVersion kill-all ✓ (T6,7), rate-limited verify ✓ (T8 authLimiter), encrypted secret ✓ (T8 encryption.encrypt).
- Type consistency: `tokenVersion`/`tv`, `mfaEnabled`, `mfaSecret`, `mfaBackupCodes`, `MfaService.verifyCode/consumeBackupCode`, `redis.denyJti/isJtiDenied/get|setUserTokenVersion`, `AuthService.revokeAllSessions/issueSessionFor` used consistently across tasks.
- Open detail for the implementer: confirm the `refreshToken` model's user-FK field name when writing `revokeAllSessions` (recon didn't quote that block).
