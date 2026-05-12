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
        data: { emailDomainStatus: (data as { status?: string }).status ?? 'pending' },
      });
      return ((data as { records?: unknown[] }).records ?? []).map(toDnsRecord);
    }

    const { data, error } = await client.domains.create({ name: store.domain });
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
  }

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

    const sdkPayload: Record<string, unknown> = {
      from: sender.from,
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
    };
    if (sender.replyTo) sdkPayload.replyTo = sender.replyTo;
    if (opts.text) sdkPayload.text = opts.text;

    const { data, error } = await client.emails.send(
      sdkPayload as Parameters<typeof client.emails.send>[0]
    );
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
