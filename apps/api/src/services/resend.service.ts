import { Resend } from 'resend';
import { prisma } from '@force/database';
import { config } from '../config';
import logger from '../lib/logger';
import { resolveSender } from './email-sender';

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

// True when a Resend SDK error represents a missing resource (deleted/unknown
// domain id). The SDK shapes this as { name: 'not_found', statusCode: 404,
// message: 'Domain not found' } — match defensively across SDK versions.
function isResendNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; statusCode?: number; message?: string };
  return (
    e.name === 'not_found' ||
    e.statusCode === 404 ||
    (typeof e.message === 'string' && /not\s*found/i.test(e.message))
  );
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
    const domainName = store.domain;

    // Create a brand-new Resend domain and persist its id/status.
    const createFresh = async (): Promise<DomainDnsRecord[]> => {
      const { data, error } = await client.domains.create({ name: domainName });
      if (error || !data) {
        throw new Error(`Resend create-domain failed: ${error?.message ?? 'unknown'}`);
      }
      await prisma.store.update({
        where: { id: storeId },
        data: {
          emailDomainId: (data as { id: string }).id,
          emailDomainStatus: (data as { status?: string }).status ?? 'pending',
        },
      });
      return ((data as { records?: unknown[] }).records ?? []).map(toDnsRecord);
    };

    if (store.emailDomainId) {
      // Already provisioned — fetch current state.
      const { data, error } = await client.domains.get(store.emailDomainId);

      if (data) {
        await prisma.store.update({
          where: { id: storeId },
          data: { emailDomainStatus: (data as { status?: string }).status ?? 'pending' },
        });
        return ((data as { records?: unknown[] }).records ?? []).map(toDnsRecord);
      }

      // The stored id 404s when the domain was deleted on Resend's side (DB
      // and Resend drifted — verified 2026-06-27: wadyaljuz.com had
      // emailDomainStatus='verified' locally but Resend returned 404, so the
      // merchant could never re-add it). Clear the stale id and create fresh
      // instead of hard-erroring on every retry.
      if (isResendNotFound(error)) {
        logger.warn(
          { storeId, staleDomainId: store.emailDomainId },
          'Resend domain id no longer exists — clearing stale id and recreating'
        );
        await prisma.store.update({
          where: { id: storeId },
          data: { emailDomainId: null, emailDomainStatus: null, emailDomainVerifiedAt: null },
        });
        return createFresh();
      }

      throw new Error(`Resend get-domain failed: ${error?.message ?? 'unknown'}`);
    }

    return createFresh();
  }

  /**
   * Kick off Resend DNS verification AND fetch the latest status. Two
   * Resend endpoints exist: GET /domains/:id returns current state,
   * POST /domains/:id/verify tells Resend to START verifying. Calling
   * only GET leaves a freshly-provisioned domain at `not_started`
   * forever — which is exactly what bit wadyaljuz.com 2026-05-13.
   *
   * Now the admin's "Verify" button trigger:
   *   1. POST /domains/:id/verify (the kick-off — ignored if already verified)
   *   2. GET /domains/:id (read back the resulting status + records)
   *   3. Persist `emailDomainStatus` + `emailDomainVerifiedAt` on the store row
   *
   * Resend's verify endpoint is idempotent: calling it on an already-verified
   * domain returns success without changing anything. So merchants can click
   * Verify any time without worry.
   */
  static async verifyAndRefreshDomain(storeId: string): Promise<{
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

    // Step 1: kick off verification. Resend's SDK exposes this as
    // `domains.verify(id)`. Failures here we log but don't throw — the
    // GET below will still surface useful state to the merchant.
    try {
      const { error: verifyError } = await ensureClient().domains.verify(store.emailDomainId);
      if (verifyError && verifyError.name !== 'not_found') {
        logger.warn(
          { storeId, domainId: store.emailDomainId, err: verifyError.message },
          'Resend domains.verify returned error; continuing to GET to read current state'
        );
      }
    } catch (err) {
      logger.warn(
        {
          storeId,
          domainId: store.emailDomainId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Resend domains.verify threw; continuing to GET'
      );
    }

    // Step 2: read the resulting state.
    return this.refreshDomainStatus(storeId);
  }

  /**
   * Fetch latest Resend status, persist it, and return status + DNS records.
   * Used both by the public verify flow above (after kicking off verify) and
   * standalone by GET /domain to refresh the records table without poking
   * Resend to re-verify. Setting `emailDomainVerifiedAt` only on the
   * verified→ transition so we have a stable timestamp.
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

    const status = (data as { status?: string }).status ?? 'pending';
    const updateData: { emailDomainStatus: string; emailDomainVerifiedAt?: Date } = {
      emailDomainStatus: status,
    };
    if (status === 'verified') {
      updateData.emailDomainVerifiedAt = new Date();
    }
    await prisma.store.update({ where: { id: storeId }, data: updateData });

    return {
      status,
      records: ((data as { records?: unknown[] }).records ?? []).map(toDnsRecord),
    };
  }

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

    type SendPayload = Parameters<typeof client.emails.send>[0];
    const sdkPayload: SendPayload = {
      from: sender.from,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
    };
    if (sender.replyTo) sdkPayload.replyTo = sender.replyTo;
    if (opts.text) sdkPayload.text = opts.text;

    const { data, error } = await client.emails.send(sdkPayload);
    if (error || !data) {
      throw new Error(`Resend send failed: ${error?.message ?? 'unknown'}`);
    }
    return { id: data.id };
  }
}

function toDnsRecord(r: unknown): DomainDnsRecord {
  const rec = r as {
    type?: string;
    record?: string;
    name?: string;
    value?: string;
    ttl?: string;
    priority?: number;
  };
  // Resend's SDK uses `record` for the row type ("MX"/"TXT") historically and
  // sometimes `type` — normalise to one field so the admin renders cleanly.
  return {
    type: rec.type ?? rec.record ?? 'TXT',
    name: rec.name ?? '',
    value: rec.value ?? '',
    ttl: rec.ttl,
    priority: rec.priority,
  };
}
