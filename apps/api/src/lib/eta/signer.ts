import { createHash } from 'node:crypto';
import { safeFetch } from '../safe-fetch';

/**
 * Signing seam (plan 5.7). Receipts: ETA documents an Issuer signature (CAdES-BES, Base64) but also
 * states signature validation is not deployed (https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/),
 * so `NoopSigner` ships first. B2B e-invoices REQUIRE a CAdES-BES signature made with the taxpayer's
 * eSeal on a USB token/HSM (https://sdk.invoicing.eta.gov.eg/signature-creation/) - a Worker cannot
 * hold or use that key, so the only supported shape is the merchant-side SIGNING BRIDGE: a small
 * service the merchant runs next to their token. Ebda sends it the canonical serialization and its
 * SHA-256; it returns the Base64 CAdES-BES. Ebda never stores the private key.
 */
export interface SignedDoc {
  signatureType: 'I';
  value: string;
}
export interface ReceiptSigner {
  sign(args: { uuid: string; serialized: string }): Promise<SignedDoc | null>;
}

export class NoopSigner implements ReceiptSigner {
  async sign(): Promise<null> {
    return null;
  }
}

export class SigningBridgeError extends Error {}

export class BridgeSigner implements ReceiptSigner {
  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly doFetch: (u: string, i?: RequestInit) => Promise<Response> = safeFetch
  ) {}

  async sign(args: { uuid: string; serialized: string }): Promise<SignedDoc> {
    const res = await this.doFetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        uuid: args.uuid,
        serialized: args.serialized,
        sha256: createHash('sha256').update(args.serialized, 'utf8').digest('hex'),
        format: 'CAdES-BES',
      }),
    });
    if (!res.ok) throw new SigningBridgeError(`signing bridge answered ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { signature?: string };
    if (!body.signature || !/^[A-Za-z0-9+/=]+$/.test(body.signature))
      throw new SigningBridgeError('signing bridge returned no Base64 signature');
    return { signatureType: 'I', value: body.signature };
  }
}
