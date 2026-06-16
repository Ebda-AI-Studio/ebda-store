# Per-store branded email via Resend — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every transactional email reflects the buying store. Merchants with a verified custom domain send via their own DKIM (`noreply@theirstore.com`); others fall back to `noreply@forcemediakw.com` with the store name as display name. Receipts include full order content. Backend provisions Resend invisibly — merchant sees one unified DNS-records list.

**Architecture:** Single platform Resend account. New `ResendService` (apps/api) handles domain provision / verify / remove + branded send via the Resend SDK. `Store` schema gains four columns (`emailSenderLocalPart`, `emailDomainId`, `emailDomainStatus`, `emailDomainVerifiedAt`). `EmailService.baseTemplate` is refactored to take a store context. All `EmailService.send*` methods load the store by ID and pass it through. Admin `/stores/[id]/domain` gains an email-sender card + one merged DNS list (Vercel + Resend records, merchant never sees provider names). Bug-class audit fixes the `forcemedia.com` typo along the way.

**Tech Stack:** Express + TypeScript + Prisma + Neon (api), Next.js App Router (admin), Resend SDK, vitest, Inngest (queue), next-intl (en/ar).

**Spec:** `docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md`

---

## File Structure

**Create:**

- `apps/api/src/services/email-sender.ts` — `resolveSender(store)` pure helper + types
- `apps/api/src/services/resend.service.ts` — Resend SDK wrapper (provision/verify/remove + sendBrandedEmail)
- `tests/unit/email-sender.test.ts` — resolveSender unit tests
- `tests/unit/resend-service.test.ts` — ResendService unit tests with mocked SDK
- `packages/database/prisma/migrations/20260512000000_add_store_email_sender/migration.sql` — schema migration

**Modify:**

- `packages/database/prisma/schema.prisma` — add 4 Store columns
- `apps/api/package.json` — add `resend` dep
- `apps/api/src/config/index.ts` — add `resendApiKey` env binding, fix `noreply@forcemedia.com` typo
- `apps/api/src/services/email.service.ts` — refactor `baseTemplate` to take store context; thread `storeId` through every public method
- `apps/api/src/routes/store.routes.ts` — new email-sender routes + extend GET /domain response with unified DNS list
- `apps/api/src/services/provisioning.service.ts` — add Resend domain provisioning to multi-step rollback
- `apps/api/src/lib/inngest/functions/order-created.ts` — pass storeId to EmailService calls
- `apps/api/src/lib/inngest/functions/invoice-email.ts` — pass storeId to EmailService call
- `apps/api/src/services/order.service.ts` — pass storeId to EmailService calls
- `apps/api/src/services/auth.service.ts` — pass storeId to EmailService calls (where store-scoped)
- `apps/api/src/routes/public.routes.ts` — pass storeId to EmailService calls
- `apps/admin/src/app/stores/[id]/domain/page.tsx` — email-sender card + unified DNS records list
- `apps/admin/src/app/stores/[id]/seo/page.tsx` — sender-prefix input
- `apps/admin/src/i18n/messages/en.json` + `ar.json` — new keys for email-sender UI

---

## Task 1: Schema migration — four new Store columns

**Files:**

- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/prisma/migrations/20260512000000_add_store_email_sender/migration.sql`

- [ ] **Step 1.1: Add the four columns to `Store` in schema.prisma**

Open `packages/database/prisma/schema.prisma`, locate the `Store` model (the line `model Store {` near top — find it with `grep -n "^model Store " packages/database/prisma/schema.prisma`). Insert the following inside the model body, alongside the other domain-related fields (right after the `domain String? @unique` line — find it with `grep -n "  domain " packages/database/prisma/schema.prisma`):

```prisma
  // Resend email-sender state (platform-managed under a single Resend account)
  emailSenderLocalPart  String    @default("noreply") @map("email_sender_local_part")
  emailDomainId         String?   @map("email_domain_id")
  emailDomainStatus     String?   @map("email_domain_status")
  emailDomainVerifiedAt DateTime? @map("email_domain_verified_at")
```

- [ ] **Step 1.2: Write the hand-written migration**

Create `packages/database/prisma/migrations/20260512000000_add_store_email_sender/migration.sql`:

```sql
-- Per-store branded email sender state.
-- Platform-managed under a single Resend account; admin UI surfaces the
-- merged Vercel + Resend DNS list invisibly.
ALTER TABLE "stores"
  ADD COLUMN "email_sender_local_part" TEXT NOT NULL DEFAULT 'noreply',
  ADD COLUMN "email_domain_id" TEXT,
  ADD COLUMN "email_domain_status" TEXT,
  ADD COLUMN "email_domain_verified_at" TIMESTAMP(3);
```

- [ ] **Step 1.3: Verify the migration is the latest**

Run: `ls packages/database/prisma/migrations/ | tail -3`
Expected: `20260512000000_add_store_email_sender` is the newest directory.

- [ ] **Step 1.4: Regenerate Prisma client**

Run: `npm run db:generate`
Expected: `Generated Prisma Client (...)` line, no errors.

- [ ] **Step 1.5: Typecheck**

Run: `cd packages/database && npx tsc --noEmit`
Expected: exit 0. If errors mention "Property 'emailSenderLocalPart' does not exist", the schema change didn't propagate — re-run `npm run db:generate`.

- [ ] **Step 1.6: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260512000000_add_store_email_sender
git commit -m "feat(database): add store email sender state columns

four new nullable + one defaulting field on store: emailSenderLocalPart
defaults to 'noreply', emailDomainId/emailDomainStatus/
emailDomainVerifiedAt all nullable so existing stores fall back to the
platform sender until they verify a custom domain.

part of the per-store branded email rollout — see
docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md"
```

---

## Task 2: Add `resend` package + env config

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/api/src/config/index.ts`
- Modify: `package-lock.json`

- [ ] **Step 2.1: Install the resend SDK**

Run from the repo root: `npx npm@10.8.2 install --workspace apps/api resend@4`
Expected: `added N packages` line, no audit warnings.

(Use `npx npm@10.8.2` per `feedback-npm-version-lockfile-drift.md` — the Railway Dockerfile uses npm 10; using npm 11 introduces lockfile syntax Railway can't parse.)

- [ ] **Step 2.2: Verify zero audit findings**

Run: `npm audit --audit-level=low --workspace apps/api`
Expected: `found 0 vulnerabilities`.

If anything appears, run `npm audit fix` and re-check. Per the global zero-vulns policy, the commit cannot ship with any audit finding at any severity.

- [ ] **Step 2.3: Add resendApiKey to the config module**

Open `apps/api/src/config/index.ts` and find the existing SMTP section with `grep -n "smtpFromEmail" apps/api/src/config/index.ts` (around line 138). Insert this block immediately after the SMTP section:

```ts
  // Resend SDK key (single platform-wide account; all merchant domains live
  // under it). When missing, ResendService gracefully degrades to no-op +
  // logs a warning so dev environments don't crash on every send.
  resendApiKey: process.env.RESEND_API_KEY || '',
```

Also fix the typo on the same line — change `'noreply@forcemedia.com'` to `'noreply@forcemediakw.com'` in the existing `smtpFromEmail` default. Locate with `grep -n "forcemedia.com" apps/api/src/config/index.ts`.

- [ ] **Step 2.4: Document the env var in `.env.example`**

Open `apps/api/.env.example` (create if missing — `test -f apps/api/.env.example || touch apps/api/.env.example`). Append:

```
# Resend API key — single platform-wide account. All merchant custom domains
# get added to it as verified senders. Free tier: 100/day, 3k/mo.
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
```

- [ ] **Step 2.5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit | grep -E "config/index|resend" | head`
Expected: empty output (no errors specific to our changes).

- [ ] **Step 2.6: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/src/config/index.ts apps/api/.env.example
git commit -m "feat(api): add resend sdk dependency + config

installs resend@4 in apps/api workspace, exposes resendApiKey config
binding (graceful no-op when unset), documents RESEND_API_KEY in
.env.example. also fixes the smtpFromEmail typo
(noreply@forcemedia.com -> noreply@forcemediakw.com) along the way."
```

---

## Task 3: Sender resolution helper (TDD)

**Files:**

- Create: `apps/api/src/services/email-sender.ts`
- Create: `tests/unit/email-sender.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Create `tests/unit/email-sender.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSender, type StoreSenderShape } from '@api/services/email-sender';

const baseStore = (overrides: Partial<StoreSenderShape> = {}): StoreSenderShape => ({
  name: 'Wady Aljuz',
  domain: null,
  email: null,
  emailSenderLocalPart: 'noreply',
  emailDomainStatus: null,
  ...overrides,
});

describe('resolveSender', () => {
  it('falls back to platform domain when no custom domain', () => {
    const result = resolveSender(baseStore());
    expect(result.from).toBe('Wady Aljuz <noreply@forcemediakw.com>');
    expect(result.replyTo).toBeUndefined();
  });

  it('falls back when custom domain set but not verified', () => {
    const result = resolveSender(
      baseStore({ domain: 'wadyaljuz.com', emailDomainStatus: 'pending' })
    );
    expect(result.from).toBe('Wady Aljuz <noreply@forcemediakw.com>');
  });

  it('uses custom domain when verified', () => {
    const result = resolveSender(
      baseStore({ domain: 'wadyaljuz.com', emailDomainStatus: 'verified' })
    );
    expect(result.from).toBe('Wady Aljuz <noreply@wadyaljuz.com>');
  });

  it('honours custom local part on verified domain', () => {
    const result = resolveSender(
      baseStore({
        domain: 'wadyaljuz.com',
        emailDomainStatus: 'verified',
        emailSenderLocalPart: 'hello',
      })
    );
    expect(result.from).toBe('Wady Aljuz <hello@wadyaljuz.com>');
  });

  it('honours custom local part on platform fallback too', () => {
    const result = resolveSender(baseStore({ emailSenderLocalPart: 'orders' }));
    expect(result.from).toBe('Wady Aljuz <orders@forcemediakw.com>');
  });

  it('sets replyTo to store contact email when present', () => {
    const result = resolveSender(baseStore({ email: 'hi@wadyaljuz.com' }));
    expect(result.replyTo).toBe('hi@wadyaljuz.com');
  });

  it('treats empty-string local part as default noreply', () => {
    const result = resolveSender(baseStore({ emailSenderLocalPart: '' }));
    expect(result.from).toBe('Wady Aljuz <noreply@forcemediakw.com>');
  });
});
```

- [ ] **Step 3.2: Run the tests — expect FAIL**

Run: `npx vitest run tests/unit/email-sender.test.ts`
Expected: FAIL with `Cannot find module '@api/services/email-sender'`.

- [ ] **Step 3.3: Implement the helper**

Create `apps/api/src/services/email-sender.ts`:

```ts
// Sender resolution for branded transactional email.
// See docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md
//
// Why a standalone module: this is a pure function (no I/O, no DB) so it
// gets the cheapest possible unit tests — feed it a plain object, assert
// the from-line. The full ResendService composes this helper.

export const PLATFORM_EMAIL_DOMAIN = 'forcemediakw.com';

export interface StoreSenderShape {
  name: string;
  domain?: string | null;
  email?: string | null;
  emailSenderLocalPart?: string | null;
  emailDomainStatus?: string | null;
}

export interface ResolvedSender {
  from: string;
  replyTo?: string;
}

export function resolveSender(store: StoreSenderShape): ResolvedSender {
  const displayName = store.name;
  const localPart =
    store.emailSenderLocalPart && store.emailSenderLocalPart.trim().length > 0
      ? store.emailSenderLocalPart.trim()
      : 'noreply';

  const useCustomDomain =
    store.emailDomainStatus === 'verified' && !!store.domain && store.domain.length > 0;

  const host = useCustomDomain ? (store.domain as string) : PLATFORM_EMAIL_DOMAIN;

  return {
    from: `${displayName} <${localPart}@${host}>`,
    replyTo: store.email ? store.email : undefined,
  };
}
```

- [ ] **Step 3.4: Run the tests — expect PASS**

Run: `npx vitest run tests/unit/email-sender.test.ts`
Expected: `7 passed`.

- [ ] **Step 3.5: Commit**

```bash
git add apps/api/src/services/email-sender.ts tests/unit/email-sender.test.ts
git commit -m "feat(api): add resolveSender helper for per-store email from-line

pure function — returns the From + reply-to pair for a given store
based on domain + verification status. falls back to the platform
host when the store has no verified custom domain. 7 unit tests cover
the fallback rules + custom local-part + replyTo handling."
```

---

## Task 4: ResendService — domain provisioning (TDD)

**Files:**

- Create: `apps/api/src/services/resend.service.ts`
- Create: `tests/unit/resend-service.test.ts`

- [ ] **Step 4.1: Write the failing provision test**

Create `tests/unit/resend-service.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockDomainsCreate = vi.fn();
const mockDomainsGet = vi.fn();
const mockDomainsRemove = vi.fn();
const mockEmailsSend = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    domains: {
      create: mockDomainsCreate,
      get: mockDomainsGet,
      remove: mockDomainsRemove,
    },
    emails: { send: mockEmailsSend },
  })),
}));

const prismaUpdateMock = vi.fn();
const prismaFindUniqueMock = vi.fn();
vi.mock('@force/database', () => ({
  prisma: {
    store: { update: prismaUpdateMock, findUnique: prismaFindUniqueMock },
  },
}));

vi.mock('@api/config', () => ({
  config: { resendApiKey: 're_test_key' },
}));

import { ResendService } from '@api/services/resend.service';

describe('ResendService.provisionStoreDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a Resend domain and persists the returned id + initial records', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      domain: 'wadyaljuz.com',
      emailDomainId: null,
    });
    mockDomainsCreate.mockResolvedValue({
      data: {
        id: 'd_abc123',
        name: 'wadyaljuz.com',
        status: 'pending',
        records: [
          {
            type: 'TXT',
            name: 'send.wadyaljuz.com',
            value: 'v=spf1 include:amazonses.com ~all',
            ttl: 'Auto',
          },
          {
            type: 'CNAME',
            name: 'resend._domainkey',
            value: 'resend.dkim.amazonses.com',
            ttl: 'Auto',
          },
        ],
      },
      error: null,
    });

    const records = await ResendService.provisionStoreDomain('store-1');

    expect(mockDomainsCreate).toHaveBeenCalledWith({ name: 'wadyaljuz.com' });
    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainId: 'd_abc123', emailDomainStatus: 'pending' },
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ type: 'TXT', name: 'send.wadyaljuz.com' });
  });

  it('is idempotent — if store already has emailDomainId, just refresh and return the records', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      domain: 'wadyaljuz.com',
      emailDomainId: 'd_existing',
    });
    mockDomainsGet.mockResolvedValue({
      data: {
        id: 'd_existing',
        status: 'verified',
        records: [{ type: 'TXT', name: 'send.wadyaljuz.com', value: '...', ttl: 'Auto' }],
      },
      error: null,
    });

    const records = await ResendService.provisionStoreDomain('store-1');

    expect(mockDomainsCreate).not.toHaveBeenCalled();
    expect(mockDomainsGet).toHaveBeenCalledWith('d_existing');
    expect(records).toHaveLength(1);
  });

  it('throws when store has no custom domain set', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      domain: null,
      emailDomainId: null,
    });
    await expect(ResendService.provisionStoreDomain('store-1')).rejects.toThrow(
      /no custom domain/i
    );
    expect(mockDomainsCreate).not.toHaveBeenCalled();
  });

  it('throws when Resend returns an error', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      domain: 'wadyaljuz.com',
      emailDomainId: null,
    });
    mockDomainsCreate.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'Domain already exists on another account' },
    });
    await expect(ResendService.provisionStoreDomain('store-1')).rejects.toThrow(/already exists/);
  });
});
```

- [ ] **Step 4.2: Run the tests — expect FAIL**

Run: `npx vitest run tests/unit/resend-service.test.ts`
Expected: FAIL with `Cannot find module '@api/services/resend.service'`.

- [ ] **Step 4.3: Implement ResendService skeleton + provisionStoreDomain**

Create `apps/api/src/services/resend.service.ts`:

```ts
import { Resend } from 'resend';
import { prisma } from '@force/database';
import { config } from '../config';
import logger from '../lib/logger';

// Resend SDK wrapper — single platform-wide account. Merchant domains
// live under it as verified senders. See spec at
// docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md
//
// The class isolates two concerns from the rest of the codebase:
// (a) the actual SDK calls (so tests can mock one module), and
// (b) the persistence of Resend's domain id/status onto the Store row
// (so callers never need to know how we track Resend state).

export interface DomainDnsRecord {
  type: string;
  name: string;
  value: string;
  ttl?: string;
  priority?: number;
}

let _client: Resend | null = null;
function getClient(): Resend | null {
  if (!config.resendApiKey) return null;
  if (!_client) _client = new Resend(config.resendApiKey);
  return _client;
}

function ensureClient(): Resend {
  const c = getClient();
  if (!c) {
    throw new Error('RESEND_API_KEY not configured');
  }
  return c;
}

export class ResendService {
  static isConfigured(): boolean {
    return !!config.resendApiKey;
  }

  /**
   * Create (or refresh, if already created) a Resend domain for the store's
   * custom domain. Persists `emailDomainId` + `emailDomainStatus` and returns
   * the DNS records the merchant needs to add at their registrar.
   * Idempotent — safe to call repeatedly.
   */
  static async provisionStoreDomain(storeId: string): Promise<DomainDnsRecord[]> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, domain: true, emailDomainId: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    if (!store.domain) throw new Error('Store has no custom domain to provision');

    const client = ensureClient();

    if (store.emailDomainId) {
      // Already provisioned — fetch current state.
      const { data, error } = await client.domains.get(store.emailDomainId);
      if (error || !data) {
        throw new Error(`Resend get-domain failed: ${error?.message ?? 'unknown'}`);
      }
      await prisma.store.update({
        where: { id: storeId },
        data: { emailDomainStatus: data.status ?? 'pending' },
      });
      return (data.records ?? []).map(toDnsRecord);
    }

    const { data, error } = await client.domains.create({ name: store.domain });
    if (error || !data) {
      throw new Error(`Resend create-domain failed: ${error?.message ?? 'unknown'}`);
    }

    await prisma.store.update({
      where: { id: storeId },
      data: { emailDomainId: data.id, emailDomainStatus: data.status ?? 'pending' },
    });

    return (data.records ?? []).map(toDnsRecord);
  }
}

function toDnsRecord(r: {
  type?: string;
  record?: string;
  name?: string;
  value?: string;
  ttl?: string;
  priority?: number;
}): DomainDnsRecord {
  // Resend's SDK uses `record` for the row type ("MX"/"TXT") historically and
  // sometimes `type` — normalise to one field so the admin renders cleanly.
  return {
    type: r.type ?? r.record ?? 'TXT',
    name: r.name ?? '',
    value: r.value ?? '',
    ttl: r.ttl,
    priority: r.priority,
  };
}
```

- [ ] **Step 4.4: Run the tests — expect PASS**

Run: `npx vitest run tests/unit/resend-service.test.ts`
Expected: `4 passed`.

- [ ] **Step 4.5: Commit**

```bash
git add apps/api/src/services/resend.service.ts tests/unit/resend-service.test.ts
git commit -m "feat(api): add ResendService skeleton + provisionStoreDomain

class wraps the Resend SDK. provisionStoreDomain is idempotent —
creates the domain on first call, fetches state on subsequent calls,
persists emailDomainId + emailDomainStatus to the store row.
returns the DNS records the merchant needs to add at their registrar.
4 unit tests cover create / refresh / no-domain / sdk-error paths."
```

---

## Task 5: ResendService.refreshDomainStatus (TDD)

**Files:**

- Modify: `apps/api/src/services/resend.service.ts`
- Modify: `tests/unit/resend-service.test.ts`

- [ ] **Step 5.1: Add the failing test**

Append to `tests/unit/resend-service.test.ts` (inside the same file, after the `provisionStoreDomain` describe block):

```ts
describe('ResendService.refreshDomainStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches latest status and persists verified + verifiedAt', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      emailDomainId: 'd_abc123',
    });
    mockDomainsGet.mockResolvedValue({
      data: {
        id: 'd_abc123',
        status: 'verified',
        records: [{ type: 'TXT', name: 'send.wadyaljuz.com', value: '...' }],
      },
      error: null,
    });

    const result = await ResendService.refreshDomainStatus('store-1');

    expect(mockDomainsGet).toHaveBeenCalledWith('d_abc123');
    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainStatus: 'verified', emailDomainVerifiedAt: expect.any(Date) },
    });
    expect(result.status).toBe('verified');
    expect(result.records).toHaveLength(1);
  });

  it('persists non-verified status without touching emailDomainVerifiedAt', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      emailDomainId: 'd_abc123',
    });
    mockDomainsGet.mockResolvedValue({
      data: { id: 'd_abc123', status: 'pending', records: [] },
      error: null,
    });

    await ResendService.refreshDomainStatus('store-1');

    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainStatus: 'pending' },
    });
  });

  it('throws if store has no emailDomainId yet', async () => {
    prismaFindUniqueMock.mockResolvedValue({ id: 'store-1', emailDomainId: null });
    await expect(ResendService.refreshDomainStatus('store-1')).rejects.toThrow(/not provisioned/i);
  });
});
```

- [ ] **Step 5.2: Run the failing test**

Run: `npx vitest run tests/unit/resend-service.test.ts -t "refreshDomainStatus"`
Expected: FAIL with `ResendService.refreshDomainStatus is not a function`.

- [ ] **Step 5.3: Implement refreshDomainStatus**

In `apps/api/src/services/resend.service.ts`, add this method inside the `ResendService` class (right after `provisionStoreDomain`):

```ts
  /**
   * Fetch latest Resend status, persist it, and return status + DNS records.
   * Admin "Verify" button calls this. Setting `emailDomainVerifiedAt` only on
   * the verified→ transition so we have a stable timestamp.
   */
  static async refreshDomainStatus(storeId: string): Promise<{
    status: string;
    records: DomainDnsRecord[];
  }> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, emailDomainId: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    if (!store.emailDomainId) {
      throw new Error('Store email sender not provisioned yet — call provisionStoreDomain first');
    }

    const { data, error } = await ensureClient().domains.get(store.emailDomainId);
    if (error || !data) {
      throw new Error(`Resend get-domain failed: ${error?.message ?? 'unknown'}`);
    }

    const status = data.status ?? 'pending';
    const updateData: { emailDomainStatus: string; emailDomainVerifiedAt?: Date } = {
      emailDomainStatus: status,
    };
    if (status === 'verified') {
      updateData.emailDomainVerifiedAt = new Date();
    }
    await prisma.store.update({ where: { id: storeId }, data: updateData });

    return {
      status,
      records: (data.records ?? []).map(toDnsRecord),
    };
  }
```

- [ ] **Step 5.4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/resend-service.test.ts -t "refreshDomainStatus"`
Expected: `3 passed`.

- [ ] **Step 5.5: Commit**

```bash
git add apps/api/src/services/resend.service.ts tests/unit/resend-service.test.ts
git commit -m "feat(api): ResendService.refreshDomainStatus

admin 'verify' button calls this. fetches latest resend status,
persists it (stamping emailDomainVerifiedAt only on verified→
transition so the timestamp is stable), returns status + records
so the admin re-renders the unified dns panel from one fetch."
```

---

## Task 6: ResendService.removeStoreDomain (TDD)

**Files:**

- Modify: `apps/api/src/services/resend.service.ts`
- Modify: `tests/unit/resend-service.test.ts`

- [ ] **Step 6.1: Add the failing test**

Append to `tests/unit/resend-service.test.ts`:

```ts
describe('ResendService.removeStoreDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes the Resend domain and clears all three columns', async () => {
    prismaFindUniqueMock.mockResolvedValue({ id: 'store-1', emailDomainId: 'd_abc123' });
    mockDomainsRemove.mockResolvedValue({ data: { id: 'd_abc123' }, error: null });

    await ResendService.removeStoreDomain('store-1');

    expect(mockDomainsRemove).toHaveBeenCalledWith('d_abc123');
    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainId: null, emailDomainStatus: null, emailDomainVerifiedAt: null },
    });
  });

  it('is a no-op when store has no emailDomainId', async () => {
    prismaFindUniqueMock.mockResolvedValue({ id: 'store-1', emailDomainId: null });
    await ResendService.removeStoreDomain('store-1');
    expect(mockDomainsRemove).not.toHaveBeenCalled();
    expect(prismaUpdateMock).not.toHaveBeenCalled();
  });

  it('clears the columns even if Resend remove returns 404 (already gone)', async () => {
    prismaFindUniqueMock.mockResolvedValue({ id: 'store-1', emailDomainId: 'd_abc123' });
    mockDomainsRemove.mockResolvedValue({
      data: null,
      error: { name: 'not_found', message: 'Domain not found' },
    });

    await ResendService.removeStoreDomain('store-1');

    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainId: null, emailDomainStatus: null, emailDomainVerifiedAt: null },
    });
  });
});
```

- [ ] **Step 6.2: Run the failing test**

Run: `npx vitest run tests/unit/resend-service.test.ts -t "removeStoreDomain"`
Expected: FAIL with `ResendService.removeStoreDomain is not a function`.

- [ ] **Step 6.3: Implement removeStoreDomain**

Append this method inside the `ResendService` class:

```ts
  /**
   * Remove the Resend domain (called from the compensating-rollback path
   * when a merchant changes/removes their custom domain). Idempotent + tolerant
   * of 'not found' — we clear the columns either way so the store doesn't
   * carry a dangling reference.
   */
  static async removeStoreDomain(storeId: string): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, emailDomainId: true },
    });
    if (!store) return;
    if (!store.emailDomainId) return;

    const client = getClient();
    if (client) {
      const { error } = await client.domains.remove(store.emailDomainId);
      if (error && error.name !== 'not_found') {
        // Log but don't throw — we still want to clear our state so the
        // store can re-provision cleanly. A dangling Resend record is
        // recoverable from the dashboard; a dangling DB reference isn't.
        logger.warn(
          { err: error.message, storeId, domainId: store.emailDomainId },
          'Resend remove-domain failed (clearing columns anyway)'
        );
      }
    }

    await prisma.store.update({
      where: { id: storeId },
      data: { emailDomainId: null, emailDomainStatus: null, emailDomainVerifiedAt: null },
    });
  }
```

- [ ] **Step 6.4: Run tests — expect PASS**

Run: `npx vitest run tests/unit/resend-service.test.ts -t "removeStoreDomain"`
Expected: `3 passed`.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/src/services/resend.service.ts tests/unit/resend-service.test.ts
git commit -m "feat(api): ResendService.removeStoreDomain

symmetric to VercelDomainService.removeDomain. clears the three
email-sender columns and best-efforts deletes the resend domain.
404 from resend is treated as success so we never leave a dangling
db reference."
```

---

## Task 7: ResendService.sendBrandedEmail (TDD)

**Files:**

- Modify: `apps/api/src/services/resend.service.ts`
- Modify: `tests/unit/resend-service.test.ts`

- [ ] **Step 7.1: Add the failing test**

Append to `tests/unit/resend-service.test.ts`:

```ts
describe('ResendService.sendBrandedEmail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves sender from store, sends via SDK, returns provider id', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      name: 'Wady Aljuz',
      domain: 'wadyaljuz.com',
      email: 'hi@wadyaljuz.com',
      emailSenderLocalPart: 'noreply',
      emailDomainStatus: 'verified',
    });
    mockEmailsSend.mockResolvedValue({ data: { id: 'em_abc' }, error: null });

    const result = await ResendService.sendBrandedEmail('store-1', {
      to: 'customer@example.com',
      subject: 'Order #123 confirmed',
      html: '<p>thanks</p>',
    });

    expect(mockEmailsSend).toHaveBeenCalledWith({
      from: 'Wady Aljuz <noreply@wadyaljuz.com>',
      to: ['customer@example.com'],
      replyTo: 'hi@wadyaljuz.com',
      subject: 'Order #123 confirmed',
      html: '<p>thanks</p>',
    });
    expect(result).toEqual({ id: 'em_abc' });
  });

  it('falls back to platform domain when store has no verified custom domain', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      name: 'Palora',
      domain: null,
      email: null,
      emailSenderLocalPart: 'noreply',
      emailDomainStatus: null,
    });
    mockEmailsSend.mockResolvedValue({ data: { id: 'em_xyz' }, error: null });

    await ResendService.sendBrandedEmail('store-1', {
      to: 'customer@example.com',
      subject: 'hi',
      html: '<p>hi</p>',
    });

    expect(mockEmailsSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Palora <noreply@forcemediakw.com>' })
    );
  });

  it('throws when Resend send returns an error', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      name: 'Palora',
      domain: null,
      email: null,
      emailSenderLocalPart: 'noreply',
      emailDomainStatus: null,
    });
    mockEmailsSend.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Slow down' },
    });

    await expect(
      ResendService.sendBrandedEmail('store-1', {
        to: 'a@b.c',
        subject: 's',
        html: '<p>p</p>',
      })
    ).rejects.toThrow(/Slow down/);
  });

  it('throws when store not found', async () => {
    prismaFindUniqueMock.mockResolvedValue(null);
    await expect(
      ResendService.sendBrandedEmail('nope', { to: 'a@b.c', subject: 's', html: '<p>p</p>' })
    ).rejects.toThrow(/Store .* not found/);
  });
});
```

- [ ] **Step 7.2: Run the failing test**

Run: `npx vitest run tests/unit/resend-service.test.ts -t "sendBrandedEmail"`
Expected: FAIL.

- [ ] **Step 7.3: Implement sendBrandedEmail**

Append to `apps/api/src/services/resend.service.ts`. Add at the top of the file (near the other imports):

```ts
import { resolveSender } from './email-sender';
```

Then add this method inside `ResendService`:

```ts
  /**
   * Send a fully-rendered branded email on behalf of a store. Caller is
   * responsible for producing the HTML — this method just resolves the
   * sender and ships it through Resend.
   */
  static async sendBrandedEmail(
    storeId: string,
    opts: { to: string | string[]; subject: string; html: string; text?: string }
  ): Promise<{ id: string }> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        domain: true,
        email: true,
        emailSenderLocalPart: true,
        emailDomainStatus: true,
      },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);

    const sender = resolveSender(store);
    const client = ensureClient();
    const { data, error } = await client.emails.send({
      from: sender.from,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      replyTo: sender.replyTo,
      subject: opts.subject,
      html: opts.html,
      ...(opts.text ? { text: opts.text } : {}),
    });
    if (error || !data) {
      throw new Error(`Resend send failed: ${error?.message ?? 'unknown'}`);
    }
    return { id: data.id };
  }
```

- [ ] **Step 7.4: Run all ResendService tests — expect PASS**

Run: `npx vitest run tests/unit/resend-service.test.ts`
Expected: `11 passed` (4 provision + 3 refresh + 3 remove + 4 send... wait that's 14. Recount: 4+3+3+4 = 14. Expected: `14 passed`).

- [ ] **Step 7.5: Commit**

```bash
git add apps/api/src/services/resend.service.ts tests/unit/resend-service.test.ts
git commit -m "feat(api): ResendService.sendBrandedEmail

loads store, resolves the per-store from-line (custom domain when
verified, platform fallback otherwise), ships via resend sdk.
4 unit tests cover verified-custom / fallback / sdk-error /
store-not-found."
```

---

## Task 8: Branded `baseTemplate(content, store)` refactor

**Files:**

- Modify: `apps/api/src/services/email.service.ts`
- Create: `tests/unit/email-template.test.ts`

- [ ] **Step 8.1: Write the failing template test**

Create `tests/unit/email-template.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderBrandedShell, type EmailStoreContext } from '@api/services/email.service';

const baseStore = (overrides: Partial<EmailStoreContext> = {}): EmailStoreContext => ({
  name: 'Wady Aljuz',
  logo: null,
  theme: null,
  email: null,
  phone: null,
  address: null,
  defaultLanguage: 'en',
  ...overrides,
});

describe('renderBrandedShell', () => {
  it('uses store name in header when no logo', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore());
    expect(html).toContain('<h1>Wady Aljuz</h1>');
    expect(html).toContain('© ' + new Date().getFullYear() + ' Wady Aljuz');
  });

  it('renders logo img when logo url present', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ logo: 'https://r2.dev/logo.png' }));
    expect(html).toContain('<img src="https://r2.dev/logo.png"');
    expect(html).not.toContain('<h1>Wady Aljuz</h1>');
  });

  it('uses store theme primary color when set (hex)', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ theme: { primary: '#2D1418' } }));
    expect(html).toContain('background: #2D1418');
  });

  it('falls back to platform orange when theme color is invalid', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ theme: { primary: 'rm -rf /' } }));
    expect(html).toContain('background: #ff6e00');
  });

  it('renders RTL when defaultLanguage is ar', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ defaultLanguage: 'ar' }));
    expect(html).toContain('dir="rtl"');
  });

  it('includes powered-by line in footer', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore());
    expect(html).toContain('Powered by Force AI Store');
  });

  it('escapes the store name to prevent XSS in header', () => {
    const html = renderBrandedShell('<p>hi</p>', baseStore({ name: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 8.2: Run the failing test**

Run: `npx vitest run tests/unit/email-template.test.ts`
Expected: FAIL with `renderBrandedShell is not exported`.

- [ ] **Step 8.3: Refactor `baseTemplate` and add the branded shell**

Open `apps/api/src/services/email.service.ts`. Add this export near the top, just after the `EmailOptions` interface:

```ts
export interface EmailStoreContext {
  name: string;
  nameAr?: string | null;
  logo?: string | null;
  theme?: { primary?: string | null } | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  defaultLanguage?: 'en' | 'ar';
}

// Validate theme primary color (HSL components or hex). Mirrors the
// `sanitizeThemeColor` helper in apps/web/src/app/layout.tsx so admin-
// controlled theme strings can't break out of the CSS declaration.
function sanitizeThemeColor(value: string | null | undefined, fallback = '#ff6e00'): string {
  if (!value || typeof value !== 'string' || value.length === 0 || value.length > 50) {
    return fallback;
  }
  if (/[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:/i.test(value)) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  const hsl =
    /^[0-9]+(?:\.[0-9]+)?\s+[0-9]+(?:\.[0-9]+)?%\s+[0-9]+(?:\.[0-9]+)?%(?:\s*\/\s*[0-9]+(?:\.[0-9]+)?%?)?$/;
  if (hsl.test(value)) return `hsl(${value})`;
  return fallback;
}

export function renderBrandedShell(content: string, store: EmailStoreContext): string {
  const dir = store.defaultLanguage === 'ar' ? 'rtl' : 'ltr';
  const primary = sanitizeThemeColor(store.theme?.primary ?? null);
  const storeName = escapeHtml(store.name);
  const header = store.logo
    ? `<img src="${escapeHtml(store.logo)}" alt="${storeName}" style="max-height:48px;display:block;margin:0 auto;">`
    : `<h1>${storeName}</h1>`;
  const year = new Date().getFullYear();
  const footerLines: string[] = [];
  if (store.address) footerLines.push(escapeHtml(store.address));
  if (store.phone) footerLines.push(escapeHtml(store.phone));
  if (store.email) footerLines.push(escapeHtml(store.email));

  return `<!DOCTYPE html>
<html dir="${dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${storeName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; }
    .header { background: ${primary}; padding: 24px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
    .content { padding: 32px 24px; }
    .footer { background: #f5f5f5; padding: 24px; text-align: center; font-size: 12px; color: #666; }
    .button { display: inline-block; background: ${primary}; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 600; }
    .order-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .order-table th, .order-table td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    .order-table th { background: #f9f9f9; }
    .total-row { font-weight: 600; font-size: 18px; }
    .address-box { background: #f9f9f9; padding: 16px; border-radius: 4px; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">${header}</div>
    <div class="content">${content}</div>
    <div class="footer">
      <p>&copy; ${year} ${storeName}. All rights reserved.</p>
      ${footerLines.map(l => `<p>${l}</p>`).join('\n      ')}
      <p style="margin-top:12px;font-size:11px;color:#999;">Powered by Force AI Store</p>
    </div>
  </div>
</body>
</html>`;
}
```

- [ ] **Step 8.4: Run the template test — expect PASS**

Run: `npx vitest run tests/unit/email-template.test.ts`
Expected: `7 passed`.

- [ ] **Step 8.5: Commit**

```bash
git add apps/api/src/services/email.service.ts tests/unit/email-template.test.ts
git commit -m "feat(api): branded email shell

renderBrandedShell(content, store) replaces the static baseTemplate.
store name in header (or logo when set), theme primary color (sanitised
the same way apps/web does), rtl when defaultLanguage='ar',
store contact lines in footer, 'powered by force store' attribution.
7 unit tests cover header / logo / theme / xss / rtl / footer."
```

---

## Task 9: Thread `storeId` through every `EmailService.send*` call site

**Files:**

- Modify: `apps/api/src/services/email.service.ts`
- Modify: `apps/api/src/lib/inngest/functions/order-created.ts`
- Modify: `apps/api/src/lib/inngest/functions/invoice-email.ts`
- Modify: `apps/api/src/services/order.service.ts`
- Modify: `apps/api/src/services/auth.service.ts`
- Modify: `apps/api/src/routes/public.routes.ts`
- Modify: `apps/api/src/services/email-queue.service.ts`

- [ ] **Step 9.1: Migrate `EmailService.send` and the per-template methods**

Open `apps/api/src/services/email.service.ts`. The strategy: every public method that currently calls `EmailService.send` or `EmailService.sendImmediate` gets an additional `storeId` parameter. The internal `baseTemplate` and `renderTemplate` helpers also take a store context. The actual SMTP transporter is replaced by `ResendService.sendBrandedEmail`.

Add at the top, near the imports:

```ts
import { prisma } from '@force/database';
import { ResendService } from './resend.service';
```

Replace the existing private `static transporter = nodemailer.createTransport(...)` block and the `send` / `sendImmediate` methods with a single new internal send helper. Find the existing transporter with `grep -n "createTransport\|static async send" apps/api/src/services/email.service.ts` and replace lines 76-174 (the transporter declaration through the end of `sendImmediate`) with:

```ts
  /**
   * Internal send helper. Loads the store record once, wraps the content
   * in the branded shell, and ships through Resend. All public methods on
   * EmailService delegate here.
   */
  private static async sendForStore(
    storeId: string,
    args: { to: string | string[]; subject: string; content: string; text?: string }
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        nameAr: true,
        logo: true,
        theme: true,
        email: true,
        phone: true,
        address: true,
        settings: true,
        domain: true,
        emailSenderLocalPart: true,
        emailDomainStatus: true,
      },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const defaultLanguage =
      (store.settings as Record<string, unknown> | null)?.defaultLanguage === 'ar' ? 'ar' : 'en';
    const html = renderBrandedShell(args.content, {
      name: store.name,
      nameAr: store.nameAr,
      logo: store.logo,
      theme: store.theme as { primary?: string | null } | null,
      email: store.email,
      phone: store.phone,
      address: store.address,
      defaultLanguage,
    });
    await ResendService.sendBrandedEmail(storeId, {
      to: args.to,
      subject: args.subject,
      html,
      text: args.text,
    });
  }

  /**
   * Platform-level send (no store context). Used only for admin alerts
   * targeting the operator's own inbox — uses the platform fallback sender.
   */
  private static async sendPlatform(args: {
    to: string | string[];
    subject: string;
    content: string;
    text?: string;
  }): Promise<void> {
    const platformStore = {
      name: 'Force AI Store',
      nameAr: null,
      logo: null,
      theme: null,
      email: null,
      phone: null,
      address: null,
      defaultLanguage: 'en' as const,
    };
    const html = renderBrandedShell(args.content, platformStore);
    // Use a synthetic platform store row OR send directly via Resend with
    // platform defaults. Cheaper to send directly since we don't need DB load.
    const client = (await import('resend')).Resend;
    const r = new (client)(config.resendApiKey);
    const { error } = await r.emails.send({
      from: `Force AI Store <noreply@forcemediakw.com>`,
      to: Array.isArray(args.to) ? args.to : [args.to],
      subject: args.subject,
      html,
      ...(args.text ? { text: args.text } : {}),
    });
    if (error) throw new Error(`Resend send failed: ${error.message}`);
  }
```

Then update each public method to take + pass `storeId`. For each `send*` method that currently looks like:

```ts
static async sendOrderConfirmation(data: OrderEmailData): Promise<void> {
  const html = this.renderTemplate('order-confirmation', data);
  await this.send({ to: data.customerEmail, subject: `Order Confirmed - #${data.orderNumber}`, html });
}
```

Change to:

```ts
static async sendOrderConfirmation(storeId: string, data: OrderEmailData): Promise<void> {
  const content = this.renderTemplate('order-confirmation', data);
  await this.sendForStore(storeId, {
    to: data.customerEmail,
    subject: `Order Confirmed - #${data.orderNumber}`,
    content,
  });
}
```

Apply the same shape to: `sendPaymentSuccess`, `sendPaymentFailed`, `sendOrderShipped`, `sendWelcome`, `sendEmailVerification`, `sendResendVerification`, `sendDuplicateRegistrationNotice`, `sendReturnConfirmation`, `sendReturnStatusUpdate`. For `sendPasswordReset` (auth-scoped — see notes below), keep `storeId` as the first arg.

For admin-targeted methods (`sendAdminNewOrder`, `sendAdminRefund`, `sendContactForm`), keep them on `sendPlatform` (operator-facing, not customer-facing — see spec § Non-goals).

Update `renderTemplate` to not wrap in baseTemplate (templates now return inner content only — the shell is wrapped once in `sendForStore`). The simplest change: in each per-template method (`orderConfirmationTemplate`, `paymentSuccessTemplate`, etc.), replace `return EmailService.baseTemplate(\`...\`)`with`return \`...\``. Find them with `grep -n "EmailService.baseTemplate" apps/api/src/services/email.service.ts` (11 sites).

Finally, **delete** the old `baseTemplate` static method.

- [ ] **Step 9.2: Update the Inngest order-created handler**

Open `apps/api/src/lib/inngest/functions/order-created.ts`. Find the two EmailService calls (lines 89-90 per the grep earlier) and update them:

```ts
// Before:
step.run('send-customer-confirmation', () => EmailService.sendOrderConfirmation(emailData)),
step.run('send-admin-new-order', () => EmailService.sendAdminNewOrder(emailData)),

// After:
step.run('send-customer-confirmation', () => EmailService.sendOrderConfirmation(storeId, emailData)),
step.run('send-admin-new-order', () => EmailService.sendAdminNewOrder(emailData)),
```

Note: `sendAdminNewOrder` stays on the platform sender (admin alerts). Only `sendOrderConfirmation` gets the per-store treatment. `storeId` is already in scope in this function from the event payload (`event.data.storeId`).

- [ ] **Step 9.3: Update the invoice-email Inngest function**

Open `apps/api/src/lib/inngest/functions/invoice-email.ts`. Replace lines 44-49 (the `EmailService.send` call) with:

```ts
try {
  await EmailService.sendInvoice(storeId, { to, orderNumber: order.orderNumber, html });
} catch (err) {
  logger.error({ err, orderId, to }, 'Invoice email send failed');
  throw err;
}
```

Then add a new `sendInvoice` public method in `email.service.ts` (alongside the other send methods):

```ts
static async sendInvoice(
  storeId: string,
  data: { to: string | string[]; orderNumber: string; html: string }
): Promise<void> {
  // Invoice HTML is generated upstream by InvoiceService — wrap it in
  // the branded shell so the merchant's logo and theme color frame
  // the invoice the customer downloads/prints.
  await this.sendForStore(storeId, {
    to: data.to,
    subject: `Invoice ${data.orderNumber}`,
    content: data.html,
  });
}
```

- [ ] **Step 9.4: Update order.service.ts**

Open `apps/api/src/services/order.service.ts`. Find the three EmailService calls (lines 694, 702, 718 per the grep). Each needs `storeId` passed in. The function scope has access to `order.storeId` — use that. Example:

```ts
// Before:
void EmailService.sendOrderShipped({ ... });

// After:
void EmailService.sendOrderShipped(order.storeId, { ... });
```

Repeat for `sendPaymentSuccess` and `sendAdminRefund` (the latter stays on platform — no storeId arg).

- [ ] **Step 9.5: Update auth.service.ts**

Open `apps/api/src/services/auth.service.ts`. Find the four EmailService calls (lines 114, 193, 252, 631 per the grep). All of these are store-scoped (auth happens in the context of a store).

For each one, locate the surrounding function to find the storeId variable, then add it as the first arg:

```ts
// Example, line 193:
await EmailService.sendEmailVerification(storeId, { email, name, verificationUrl, expiresIn });
```

If the surrounding function doesn't have a `storeId` in scope, look at the caller — these are all triggered from a store-context route. Add `storeId` to the function signature if needed.

- [ ] **Step 9.6: Update public.routes.ts**

Open `apps/api/src/routes/public.routes.ts`. The two EmailService calls (lines 996, 1026 per the grep) are inside route handlers that already have store context. Pass it through:

```ts
// Newsletter signup (line ~996):
void EmailService.sendWelcome(storeId, { email: normalizedEmail, name: '' }).catch(err => { ... });

// Contact form (line ~1026) — stays on platform sender (admin-facing, see spec):
await EmailService.sendContactForm({ ... });  // unchanged
```

- [ ] **Step 9.7: Update email-queue.service.ts**

Open `apps/api/src/services/email-queue.service.ts`. The queue currently stores `EmailOptions` and replays them via `EmailService.send`. Now the queue must also carry the storeId.

Change `QueuedEmail` interface (line ~12) to:

```ts
export interface QueuedEmail {
  id: string;
  storeId: string | null; // null for platform-targeted admin sends
  options: EmailOptions;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  lastAttempt?: string;
  error?: string;
}
```

Update `enqueue` (line ~32) to accept `storeId`:

```ts
async enqueue(storeId: string | null, options: EmailOptions): Promise<string> {
  // ... existing id-generation logic ...
  const queuedEmail: QueuedEmail = { id, storeId, options, attempts: 0, maxAttempts: MAX_ATTEMPTS, createdAt: new Date().toISOString() };
  // ... existing redis/fallback logic ...
}
```

And `sendEmail` (around line 110-115) — replace the body with:

```ts
private async sendEmail(email: QueuedEmail): Promise<void> {
  if (email.storeId) {
    await EmailService.sendRaw(email.storeId, email.options);
  } else {
    await EmailService.sendPlatformRaw(email.options);
  }
}
```

Then add two helper publics on `EmailService` for queue replay (private internals shouldn't be exposed to the queue):

```ts
// In email.service.ts:
static async sendRaw(storeId: string, options: EmailOptions): Promise<void> {
  // Bypass the renderBrandedShell wrapper — opts.html is already a full
  // document. Used by the email queue's replay path for emails that were
  // already rendered before being enqueued.
  await ResendService.sendBrandedEmail(storeId, {
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
}

static async sendPlatformRaw(options: EmailOptions): Promise<void> {
  // Platform-fallback equivalent of sendRaw for queue replay.
  // ... (mirror the body of sendPlatform but take pre-rendered html)
  const client = (await import('resend')).Resend;
  const r = new (client)(config.resendApiKey);
  const { error } = await r.emails.send({
    from: `Force AI Store <noreply@forcemediakw.com>`,
    to: Array.isArray(options.to) ? options.to : [options.to],
    subject: options.subject,
    html: options.html,
    ...(options.text ? { text: options.text } : {}),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
}
```

- [ ] **Step 9.8: Update the existing email-queue tests**

Open `tests/unit/email-queue.test.ts`. Update the `enqueue` calls in tests to pass `storeId`:

```ts
// Find lines that call emailQueue.enqueue(emailOptions) and change to:
const id = await emailQueue.enqueue('store-1', emailOptions);
```

Update the mock setup for `EmailService` (line ~19-23) to mock `sendRaw` + `sendPlatformRaw` instead of `send`:

```ts
vi.mock('@api/services/email.service', () => ({
  EmailService: {
    sendRaw: vi.fn(),
    sendPlatformRaw: vi.fn(),
  },
}));
```

- [ ] **Step 9.9: Run all email-related tests**

Run: `npx vitest run tests/unit/email-queue.test.ts tests/unit/email-sender.test.ts tests/unit/email-template.test.ts tests/unit/resend-service.test.ts`
Expected: all green. If `email-queue.test.ts` has stale assertions about the `send` method, update them to assert against `sendRaw` instead.

- [ ] **Step 9.10: Typecheck the api workspace**

Run: `cd apps/api && npx tsc --noEmit`
Expected: exit 0 (Prisma-namespace errors from the earlier session are unrelated to email work; they're acceptable as-is for this task as long as no NEW errors appear in email/auth/order/queue/inngest files).

Filter for new errors: `cd apps/api && npx tsc --noEmit 2>&1 | grep -E "email|resend|inngest" | head`
Expected: empty.

- [ ] **Step 9.11: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): thread storeId through every email send call site

every customer-facing email now loads the buying store and ships
via ResendService with that store's branded shell + per-store from
line. admin-facing alerts (new-order, refund, contact-form) keep
the platform sender. email-queue queues storeId alongside options
so replay through the redis queue still picks the right sender.

migrated call sites: order-created inngest fn, invoice-email inngest
fn, order.service (shipped + payment-success), auth.service
(verification, welcome, password-reset, duplicate-notice),
public.routes (newsletter welcome). admin-targeted calls in
order.service (refund) + public.routes (contact-form) unchanged."
```

---

## Task 10: API routes — provision + verify + extended GET /domain

**Files:**

- Modify: `apps/api/src/routes/store.routes.ts`

- [ ] **Step 10.1: Add the email-sender routes**

Open `apps/api/src/routes/store.routes.ts`. Add the import near the top with the other service imports:

```ts
import { ResendService } from '../services/resend.service';
```

Find the existing PUT `/:id/domain` block (around line 716 per the grep), and immediately after it (before any unrelated route below), insert:

```ts
// POST /stores/:id/email-sender/provision — create or refresh the Resend
// domain entry and return the DNS records the merchant must add. Idempotent.
router.post(
  '/:id/email-sender/provision',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const records = await ResendService.provisionStoreDomain(req.params.id);
      res.json({ success: true, data: { records } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:id/email-sender/verify — refresh status from Resend.
router.post(
  '/:id/email-sender/verify',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await ResendService.refreshDomainStatus(req.params.id);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);
```

- [ ] **Step 10.2: Extend GET /:id/domain to return unified DNS records**

In the existing GET `/:id/domain` handler (find with `grep -n "GET /stores/:id/domain" apps/api/src/routes/store.routes.ts`, around line 680), modify the response to include the Resend records too:

```ts
// Before (around line 695-710):
const status = await VercelDomainService.getDomain(store.domain);
res.json({ success: true, data: { status } });

// After:
const [vercelStatus, store] = await Promise.all([
  VercelDomainService.getDomain(req.params.domain), // existing call
  prisma.store.findUnique({
    where: { id: req.params.id },
    select: { id: true, emailDomainId: true, emailDomainStatus: true, emailDomainVerifiedAt: true },
  }),
]);
let resendRecords: Array<{ type: string; name: string; value: string }> = [];
if (store?.emailDomainId) {
  try {
    const refreshed = await ResendService.refreshDomainStatus(req.params.id);
    resendRecords = refreshed.records.map(r => ({ type: r.type, name: r.name, value: r.value }));
  } catch (err) {
    logger.warn({ err, storeId: req.params.id }, 'Resend status fetch failed during GET /domain');
  }
}
const mergedDns = [...(vercelStatus?.dnsRecords ?? []), ...resendRecords];
res.json({
  success: true,
  data: {
    status: vercelStatus,
    emailSender: {
      domainId: store?.emailDomainId ?? null,
      status: store?.emailDomainStatus ?? null,
      verifiedAt: store?.emailDomainVerifiedAt ?? null,
    },
    dnsRecords: mergedDns,
  },
});
```

(Adapt the field names if the exact existing call differs — read the surrounding lines first with `Read` and match the response shape.)

- [ ] **Step 10.3: Run integration test (if Postgres is available)**

Run: `npm run test:integration -- --grep "email-sender"`
Expected: no test exists yet, so the run reports no matches and exits 0. (Integration tests for these routes are deferred to the smoke test in Task 15.)

- [ ] **Step 10.4: Typecheck**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep "store.routes" | head`
Expected: empty.

- [ ] **Step 10.5: Commit**

```bash
git add apps/api/src/routes/store.routes.ts
git commit -m "feat(api): email-sender provision + verify routes

POST /stores/:id/email-sender/provision creates the resend domain
entry (idempotent) and returns the dns records merchant must add.
POST /stores/:id/email-sender/verify refreshes status. GET
/stores/:id/domain now returns the merged dns list (vercel + resend)
in one payload so admin renders the unified panel from one fetch.
all three follow the existing authenticate → authorize → require-
storeAccess chain."
```

---

## Task 11: Compensating-rollback wiring on PUT /stores/:id/domain

**Files:**

- Modify: `apps/api/src/routes/store.routes.ts`
- Modify: `apps/api/src/services/provisioning.service.ts`

- [ ] **Step 11.1: Extend PUT /stores/:id/domain to provision Resend after Vercel succeeds**

Open `apps/api/src/routes/store.routes.ts`. Find the PUT `/:id/domain` handler (around line 716). The current order is: Vercel addDomain → DB update → fire-and-forget remove old Vercel domain. After this task, the order becomes:

1. Vercel `addDomain(new)` (commit + rollback armed)
2. DB update (write new domain)
3. Resend `provisionStoreDomain(storeId)` (best-effort, no rollback — failure leaves email on platform fallback)
4. Disarm Vercel rollback
5. Fire-and-forget: remove old Vercel domain
6. Fire-and-forget: Resend `removeStoreDomain` on the OLD domain (only if the old Resend record existed)

Find the section that disarms the rollback (`rollbackVercelAdd = null` around line 826) and the fire-and-forget removal block (around line 837). Insert the Resend provisioning between the DB commit and the disarm. Pseudo-context:

```ts
// existing DB write happens here ...
await prisma.store.update({ where: { id }, data: { domain } });

// NEW: provision Resend in the background, but don't fail the request if
// it errors. Email branding falls back to platform until the merchant
// adds the DNS records.
try {
  await ResendService.provisionStoreDomain(id);
} catch (err) {
  logger.warn(
    { err, storeId: id, domain },
    'Resend domain provision failed (storefront still works; email stays on platform fallback)'
  );
}

// existing disarm + fire-and-forget removal ...
rollbackVercelAdd = null;
```

Also handle the OLD domain's Resend cleanup. Find the fire-and-forget Vercel `removeDomain` block (line ~837):

```ts
void VercelDomainService.removeDomain(domainToRemove).catch(error =>
  logger.error({ err: error, domainToRemove }, 'Failed to remove old domain from Vercel')
);
```

Right after it, add:

```ts
// Symmetric Resend cleanup: if the store had an old emailDomainId before
// the swap, drop it now that the new domain has been provisioned.
if (previousEmailDomainId) {
  void ResendService.removeStoreDomain(id).catch(error =>
    logger.error({ err: error, storeId: id }, 'Failed to remove old Resend domain')
  );
}
```

(Where `previousEmailDomainId` is captured BEFORE the DB update — earlier in the handler, when you fetch the existing store, also select `emailDomainId` and store it in a local const.)

- [ ] **Step 11.2: Same change for the multi-step provisioning service**

Open `apps/api/src/services/provisioning.service.ts`. Find the `VercelDomainService.addDomain` call (line ~99) and the rollback block (line ~211). Mirror the same logic: after the DB commit, call `ResendService.provisionStoreDomain(newStore.id)` inside a try/catch that only logs on failure.

- [ ] **Step 11.3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | grep -E "store.routes|provisioning" | head`
Expected: empty.

- [ ] **Step 11.4: Commit**

```bash
git add apps/api/src/routes/store.routes.ts apps/api/src/services/provisioning.service.ts
git commit -m "feat(api): wire resend provisioning into the domain change rollback

when a merchant adds/changes their custom domain, we now also create
(or swap) the resend domain entry in the same flow. failures are
logged but never block — storefront still works on vercel; email
just falls back to the platform sender until merchant adds the dns
records. old resend domain is removed fire-and-forget alongside the
old vercel domain, same compensating-rollback shape."
```

---

## Task 12: Admin UI — email-sender card + unified DNS records on `/stores/[id]/domain`

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/domain/page.tsx`
- Modify: `apps/admin/src/i18n/messages/en.json`
- Modify: `apps/admin/src/i18n/messages/ar.json`

- [ ] **Step 12.1: Read the existing domain page**

Run: `Read apps/admin/src/app/stores/[id]/domain/page.tsx` to understand the existing structure and current data shape (the GET /domain response).

- [ ] **Step 12.2: Add the email-sender card under the existing custom-domain card**

In `apps/admin/src/app/stores/[id]/domain/page.tsx`, the data fetched from GET /:id/domain now contains:

- `data.status` — existing Vercel domain status
- `data.emailSender` — `{ domainId, status, verifiedAt }`
- `data.dnsRecords` — merged Vercel + Resend list

Render two visual sections (keep the existing custom-domain section unchanged). After the custom-domain card, add:

```tsx
<div className="mt-6 rounded-xl border bg-card shadow-sm">
  <div className="border-b p-4">
    <h2 className="font-semibold text-foreground">{t('emailSenderTitle')}</h2>
    <p className="mt-1 text-sm text-muted-foreground">{t('emailSenderSubtitle')}</p>
  </div>
  <div className="p-4 space-y-4">
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-muted-foreground">{t('sendingAs')}</p>
        <p className="font-mono text-sm">{senderPreview /* computed below */}</p>
      </div>
      <EmailSenderBadge status={data?.emailSender?.status ?? null} />
    </div>
    {!data?.emailSender?.domainId && domain && (
      <Button onClick={handleProvision} disabled={isProvisioning}>
        {isProvisioning ? t('settingUp') : t('setupBrandedEmail')}
      </Button>
    )}
    {data?.emailSender?.status === 'pending' && (
      <Button onClick={handleVerify} disabled={isVerifying}>
        {isVerifying ? t('verifying') : t('verifyEmailSender')}
      </Button>
    )}
  </div>
</div>
```

`senderPreview` is computed from the local store data — show `Wady Aljuz <noreply@wadyaljuz.com>` when verified, else `Wady Aljuz <noreply@forcemediakw.com>`. Compute it client-side using the store's name, slug, and emailSender.status. (Match the same logic as `resolveSender` server-side.)

`EmailSenderBadge` is a small inline component that maps status → label + color:

- `verified` → green `t('statusVerified')`
- `pending` → amber `t('statusPending')`
- `failed` → red `t('statusFailed')`
- `null` → grey `t('statusNotConfigured')`

`handleProvision` posts to `/api/v1/stores/${id}/email-sender/provision`, then refetches.
`handleVerify` posts to `/api/v1/stores/${id}/email-sender/verify`, then refetches.

- [ ] **Step 12.3: Replace the existing Vercel-records list with the unified merged list**

Wherever the current page renders the Vercel DNS records list (one row per record, copy-button alongside), swap the data source from `data.status.dnsRecords` to `data.dnsRecords`. Section heading changes from "Vercel records to add" (or similar) to a neutral `t('dnsRecordsTitle')` ("DNS records to add at your registrar"). The merchant never sees the provider names.

- [ ] **Step 12.4: Add the i18n keys**

Open `apps/admin/src/i18n/messages/en.json`. Find the existing domain-page section (search for `"domain"` key). Add these keys to the same section:

```json
"emailSenderTitle": "Email sender",
"emailSenderSubtitle": "Send order confirmations and receipts under your own domain.",
"sendingAs": "Sending as",
"setupBrandedEmail": "Set up branded email",
"verifyEmailSender": "Verify",
"verifying": "Verifying...",
"settingUp": "Setting up...",
"statusVerified": "Verified",
"statusPending": "Pending DNS verification",
"statusFailed": "Verification failed",
"statusNotConfigured": "Not configured",
"dnsRecordsTitle": "DNS records to add at your registrar",
"dnsRecordsHint": "Copy each row into your domain registrar's DNS settings. We verify automatically once they propagate."
```

Repeat in `ar.json`:

```json
"emailSenderTitle": "مرسل البريد الإلكتروني",
"emailSenderSubtitle": "أرسل تأكيدات الطلبات والإيصالات من نطاقك الخاص.",
"sendingAs": "يُرسل باسم",
"setupBrandedEmail": "إعداد البريد الإلكتروني المخصص",
"verifyEmailSender": "تحقق",
"verifying": "جارٍ التحقق...",
"settingUp": "جارٍ الإعداد...",
"statusVerified": "موثق",
"statusPending": "بانتظار تحقق DNS",
"statusFailed": "فشل التحقق",
"statusNotConfigured": "غير مهيأ",
"dnsRecordsTitle": "سجلات DNS المطلوب إضافتها لدى مسجل النطاق",
"dnsRecordsHint": "انسخ كل صف إلى إعدادات DNS لدى مسجل نطاقك. سنتحقق تلقائيًا بمجرد انتشار التغييرات."
```

- [ ] **Step 12.5: Validate JSON parse**

Run: `cd apps/admin && jq empty src/i18n/messages/en.json && jq empty src/i18n/messages/ar.json && echo ok`
Expected: `ok`.

- [ ] **Step 12.6: Typecheck admin**

Run: `cd apps/admin && npx tsc --noEmit | grep "stores/.id./domain" | head`
Expected: empty.

- [ ] **Step 12.7: Commit**

```bash
git add apps/admin/src
git commit -m "feat(admin): email-sender card + unified dns list on /stores/[id]/domain

new card under the existing custom-domain card. shows current
sender (\"sending as: Wady Aljuz <noreply@wadyaljuz.com>\") + status
badge. 'set up branded email' button when not provisioned;
'verify' button when pending. dns records section now renders the
merged vercel + resend list under a neutral heading — merchant
never sees provider names. en + ar i18n covered."
```

---

## Task 13: Admin — sender-prefix input on `/stores/[id]/seo`

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/seo/page.tsx`
- Modify: `apps/admin/src/i18n/messages/en.json`
- Modify: `apps/admin/src/i18n/messages/ar.json`
- Modify: `apps/api/src/routes/store.routes.ts` (extend SEO schema with the prefix field)

- [ ] **Step 13.1: Extend the SEO Zod schema on the API**

Open `apps/api/src/routes/store.routes.ts`. Find the `seoSchema` definition (line 83 per the grep earlier). Add a new optional field:

```ts
// Local-part for the from-line on per-store sender. Must be RFC-5321 safe.
const optionalEmailLocalPart = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z
    .string()
    .regex(
      /^[a-z0-9._-]+$/,
      'Sender prefix must be lowercase letters, numbers, dot/hyphen/underscore only'
    )
    .max(64)
    .optional()
);

const seoSchema = z
  .object({
    // ... existing fields ...
    emailSenderLocalPart: optionalEmailLocalPart,
  })
  .strip();
```

And in the StoreService.updateSeo body (apps/api/src/services/store.service.ts line ~535), add to the destructure + update:

```ts
emailSenderLocalPart?: string;
// ...
data: { /* ... */, emailSenderLocalPart: seo.emailSenderLocalPart, }
```

- [ ] **Step 13.2: Add the field to the admin SEO page**

Open `apps/admin/src/app/stores/[id]/seo/page.tsx`. Find the `SeoSettings` interface (line ~11) and add `emailSenderLocalPart`:

```ts
interface SeoSettings {
  // ... existing fields ...
  emailSenderLocalPart: string;
}

const DEFAULT_SETTINGS: SeoSettings = {
  // ... existing fields ...
  emailSenderLocalPart: 'noreply',
};
```

Update the fetch handler to read it from the response (~line 81):

```ts
emailSenderLocalPart: seo.emailSenderLocalPart || 'noreply',
```

Then add the input — locate the Google Site Verification field (~line 381 per earlier grep) and insert immediately after the closing `</div>` for that field:

```tsx
<div>
  <label className="block text-sm font-medium text-foreground mb-1">{t('senderPrefix')}</label>
  <div className="flex items-center rounded-lg border border-border overflow-hidden">
    <input
      type="text"
      value={settings.emailSenderLocalPart}
      onChange={e =>
        setSettings(prev => ({
          ...prev,
          emailSenderLocalPart: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''),
        }))
      }
      placeholder="noreply"
      className="flex-1 px-3 py-2 text-sm focus:outline-none"
    />
    <span className="bg-muted px-3 py-2 text-sm text-muted-foreground">@{senderHostPreview}</span>
  </div>
  <p className="mt-1 text-xs text-muted-foreground">{t('senderPrefixHint')}</p>
</div>
```

`senderHostPreview` is computed from the same data your admin already has — if `emailDomain.status === 'verified'` and a custom domain exists, show the custom domain; else show `forcemediakw.com`. If you don't have that data on this page, fetch it once on mount (`apiGet('/api/v1/stores/${id}/domain')` and read `data.emailSender.status` + the store's domain).

- [ ] **Step 13.3: Add the i18n keys**

In `apps/admin/src/i18n/messages/en.json` under the same SEO section:

```json
"senderPrefix": "Email sender prefix",
"senderPrefixHint": "The part before the @ on outgoing emails. Default: noreply. Examples: hello, orders, support. Letters/digits/dot/hyphen/underscore only."
```

`ar.json`:

```json
"senderPrefix": "بادئة البريد الإلكتروني",
"senderPrefixHint": "الجزء قبل @ في البريد الصادر. الافتراضي: noreply. أمثلة: hello, orders, support. حروف وأرقام ونقطة وشرطة وشرطة سفلية فقط."
```

- [ ] **Step 13.4: Validate JSON + typecheck**

```bash
cd apps/admin && jq empty src/i18n/messages/en.json && jq empty src/i18n/messages/ar.json && echo ok
cd apps/admin && npx tsc --noEmit | head -5
```

Expected: `ok` + (empty or pre-existing unrelated errors only).

- [ ] **Step 13.5: Commit**

```bash
git add apps/api/src apps/admin/src
git commit -m "feat(admin): sender prefix input on /stores/[id]/seo

new field on the seo page lets merchants override the default 'noreply'
local part with 'hello', 'orders', 'support', etc. server-side zod
schema validates [a-z0-9._-]+ max 64 chars. client-side input strips
invalid chars on type. live host suffix preview shows whether the
verified custom domain or the platform fallback will be used.
en + ar i18n covered."
```

---

## Task 14: Bug-class audit — `forcemedia.com` typo + hardcoded "Force Media" subjects

**Files:**

- Multiple — discovered via grep

- [ ] **Step 14.1: Audit for the typo**

Run: `grep -rn "forcemedia\.com" apps packages --include="*.ts" --include="*.tsx" --include="*.json" 2>/dev/null | grep -v "forcemediakw\.com" | grep -v node_modules`
Expected: every match is a real instance of the typo. The config default already got fixed in Task 2; this sweep catches any siblings.

For each remaining match, replace with `forcemediakw.com`. Use `Edit` per file.

- [ ] **Step 14.2: Audit for hardcoded "Force Media" in customer-facing subjects**

Run: `grep -rn "Force Media\|Force AI Store" apps/api/src --include="*.ts" 2>/dev/null | grep -v node_modules | grep -iE "subject|title"`
Expected output lists call sites that hardcode the brand in subject lines.

For customer-facing emails, replace the hardcoded string with `${store.name}`. Example: `subject: 'Welcome to Force Media!'` → `subject: \`Welcome to ${store.name}!\``. Skip admin-facing sends (those keep platform branding per the spec).

- [ ] **Step 14.3: Run all email tests + typecheck**

```bash
npx vitest run tests/unit/email-sender.test.ts tests/unit/resend-service.test.ts tests/unit/email-template.test.ts tests/unit/email-queue.test.ts
cd apps/api && npx tsc --noEmit | grep -E "email" | head
```

Expected: all tests pass; typecheck clean for email files.

- [ ] **Step 14.4: Commit**

```bash
git add -p   # interactively stage only the relevant changes
git commit -m "fix(api): bug-class audit — forcemedia.com typo + hardcoded brand in subjects

sweeping fix for every 'forcemedia.com' (missing the 'kw') across apps
+ packages, and every customer-facing email subject that hardcoded
'Force Media' or 'Force AI Store' now interpolates store.name. admin-
facing subjects unchanged."
```

---

## Task 15: Smoke test — send a real branded email from Wady Aljuz

**Files:** none (manual verification + temporary script)

- [ ] **Step 15.1: Ensure local env has RESEND_API_KEY**

```bash
grep RESEND_API_KEY apps/api/.env || echo "MISSING - add it"
```

If missing, add the real key from Ahmad's Resend dashboard.

- [ ] **Step 15.2: Run a dev API server**

```bash
npm run dev:api
```

In another shell, find Wady Aljuz's store id:

```bash
psql "$DATABASE_URL" -c "SELECT id, name, domain, email_sender_local_part, email_domain_status FROM stores WHERE slug='wady-aljuz' LIMIT 1;"
```

Note the `id` value.

- [ ] **Step 15.3: Provision Wady Aljuz email sender (if not already)**

```bash
curl -X POST "http://localhost:4000/api/v1/stores/<WADY_ID>/email-sender/provision" \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>" \
  -H "X-Store-ID: <WADY_ID>"
```

Expected: 200 OK with `data.records` listing TXT + CNAME entries for `wadyaljuz.com`.

- [ ] **Step 15.4: Add the DNS records on the merchant's registrar**

This is Ahmad's manual step — copy each row into the Wady Aljuz registrar's DNS panel. Wait for propagation (typically 5-30 min).

- [ ] **Step 15.5: Verify the domain via the API**

```bash
curl -X POST "http://localhost:4000/api/v1/stores/<WADY_ID>/email-sender/verify" \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>" \
  -H "X-Store-ID: <WADY_ID>"
```

Expected: `data.status === "verified"`. If still `pending`, wait for DNS propagation and retry.

- [ ] **Step 15.6: Trigger a test order confirmation**

```bash
curl -X POST "http://localhost:4000/api/v1/orders/<ANY_WADY_ORDER_ID>/resend-confirmation" \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>" \
  -H "X-Store-ID: <WADY_ID>"
```

(If a "resend confirmation" endpoint doesn't exist, write a one-off node script: `node -e "import('./apps/api/dist/services/email.service.js').then(m => m.EmailService.sendOrderConfirmation('<WADY_ID>', { ...sampleOrder }))"`.)

Check Ahmad's inbox: the email arrives from `Wady Aljuz <noreply@wadyaljuz.com>` (verified) or `Wady Aljuz <noreply@forcemediakw.com>` (fallback). Header bar uses Wady Aljuz's theme color. Footer shows Wady Aljuz contact details + "Powered by Force AI Store". Receipt content (items + totals + shipping addr) renders correctly.

- [ ] **Step 15.7: Document outcome**

If anything looks wrong, file follow-up tasks in `docs/superpowers/specs/2026-05-12-per-store-resend-email-design.md` under a new "Smoke test findings" section, then iterate.

Once the email is clean: tag this plan as complete in the task file and update project memory note `wiki/projects/force-website-builder.md` with a callout for the per-store email work.

---

## Acceptance criteria

All of the following must be true before claiming complete:

1. `npx vitest run tests/unit/email-sender.test.ts tests/unit/resend-service.test.ts tests/unit/email-template.test.ts tests/unit/email-queue.test.ts` → all green.
2. `cd apps/api && npx tsc --noEmit` → no NEW errors in email/auth/order/queue/inngest/routes files (pre-existing Prisma-namespace errors are acceptable; they predate this work).
3. `cd apps/admin && npx tsc --noEmit` → no NEW errors in stores/[id]/domain or stores/[id]/seo.
4. `grep -rn "forcemedia\.com" apps packages --include="*.ts" --include="*.tsx" --include="*.json" | grep -v "forcemediakw\.com" | grep -v node_modules` → empty (no remaining typos).
5. `grep -rn "EmailService\.baseTemplate" apps/api/src` → empty (all sites migrated to `renderBrandedShell` via `sendForStore`).
6. Smoke test (Task 15) — at least the platform-fallback path verified end-to-end (Wady Aljuz emails arrive branded). Verified-custom-domain path is bonus; depends on Ahmad's DNS step.
