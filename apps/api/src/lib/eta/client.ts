import { ETA_HOSTS, type EtaEnvironment } from '@ebda/shared';
import { timedFetch } from '../fetch-with-timeout';

/**
 * ETA e-receipt API client (per-merchant credentials, Ruling ETA-1).
 *  - Auth:   POST {identity}/connect/token, grant_type=client_credentials, headers posserial /
 *            pososversion / posmodelframework / presharedkey; token lives 3600 s
 *            (https://sdk.invoicing.eta.gov.eg/ereceiptapi/01-authenticate-pos/, read 2026-10-26).
 *            The page does not state the content type; OAuth2 `application/x-www-form-urlencoded`
 *            is used - confirm on PreProd (plan P2 exit).
 *  - Submit: POST {api}/api/v1/receiptsubmissions {receipts, signatures}; 202 with submissionUUID,
 *            acceptedDocuments[{uuid,longId,receiptNumber}], rejectedDocuments[{receiptNumber,uuid,error}];
 *            400 BadStructure / MaximumSizeExceeded, 403 IncorrectSubmitter, 422 DuplicateSubmission
 *            (Retry-After). (https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/)
 *  - Throttling: 429 -> Retry-After, 503 -> retry after 1-3 s (https://sdk.invoicing.eta.gov.eg/apigovernance/).
 *  - Result:  a 202 only means "accepted for validation". The verdict comes from
 *            GET {api}/api/v1/receiptsubmissions/{submissionUuid}/details -> status InProgress|Valid|Invalid,
 *            receipts[].status Valid|Invalid|Cancelled, longId, errors[].error.errorCode
 *            (https://sdk.invoicing.eta.gov.eg/ereceiptapi/06-get-receipt-submission/).
 * The client never logs or returns a secret.
 */
export interface EtaCredentials {
  clientId: string;
  clientSecret: string;
  posSerial: string;
  preSharedKey?: string;
}

export interface EtaAccepted {
  uuid: string;
  longId: string;
  receiptNumber: string;
}
export interface EtaRejected {
  uuid: string;
  receiptNumber: string;
  error: { message?: string; target?: string; propertyPath?: string } | string | null;
}

export type SubmitOutcome =
  | { kind: 'ok'; submissionUuid: string; accepted: EtaAccepted[]; rejected: EtaRejected[] }
  /** Transient. `afterMs` null = caller applies its own backoff. */
  | { kind: 'retry'; reason: string; afterMs: number | null }
  /** Will not succeed by retrying (bad credentials, structure, wrong submitter). */
  | { kind: 'fatal'; code: string; message: string };

const POS_OS_VERSION = '1.0';
const POS_MODEL_FRAMEWORK = '1';
const TOKEN_REFRESH_MS = 55 * 60 * 1000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const tokenCache = new Map<string, { token: string; at: number }>();

export function clearEtaTokenCache(): void {
  tokenCache.clear();
}

export type SubmissionVerdict =
  | { kind: 'in_progress' }
  | {
      kind: 'done';
      receipts: Array<{
        uuid: string;
        status: 'Valid' | 'Invalid' | 'Cancelled' | string;
        longId?: string;
        errorCode?: string;
      }>;
    }
  | { kind: 'retry'; reason: string; afterMs: number | null }
  | { kind: 'fatal'; code: string };

export class EtaClient {
  constructor(
    private readonly env: EtaEnvironment,
    private readonly creds: EtaCredentials,
    private readonly doFetch: Fetch = (u, i) => timedFetch('eta')(u, i),
    private readonly now: () => number = Date.now
  ) {}

  private cacheKey(): string {
    return `${this.env}:${this.creds.clientId}:${this.creds.posSerial}`;
  }

  async authenticate(): Promise<{ ok: true } | { ok: false; code: string; transient: boolean }> {
    const r = await this.token(true);
    return r.ok ? { ok: true } : r;
  }

  private async token(
    force = false
  ): Promise<{ ok: true; token: string } | { ok: false; code: string; transient: boolean }> {
    const key = this.cacheKey();
    const hit = tokenCache.get(key);
    if (!force && hit && this.now() - hit.at < TOKEN_REFRESH_MS)
      return { ok: true, token: hit.token };
    let res: Response;
    try {
      res = await this.doFetch(`${ETA_HOSTS[this.env].identity}/connect/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          posserial: this.creds.posSerial,
          pososversion: POS_OS_VERSION,
          posmodelframework: POS_MODEL_FRAMEWORK,
          ...(this.creds.preSharedKey ? { presharedkey: this.creds.preSharedKey } : {}),
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
        }).toString(),
      });
    } catch {
      return { ok: false, code: 'network', transient: true };
    }
    if (res.status >= 500 || res.status === 429)
      return { ok: false, code: `http_${res.status}`, transient: true };
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (res.status === 200 && body.access_token) {
      tokenCache.set(key, { token: body.access_token, at: this.now() });
      return { ok: true, token: body.access_token };
    }
    // 400 invalid_posserial / invalid_presharedkey / unauthorized_client / ... : surface ETA's code only.
    return {
      ok: false,
      code: String(body.error ?? `http_${res.status}`).slice(0, 60),
      transient: false,
    };
  }

  async submitReceipts(
    receipts: unknown[],
    signatures: Array<{ signatureType: 'I' | 'S'; value: string }> = [],
    retriedAuth = false
  ): Promise<SubmitOutcome> {
    const tok = await this.token();
    if (!tok.ok) {
      return tok.transient
        ? { kind: 'retry', reason: `auth_${tok.code}`, afterMs: null }
        : {
            kind: 'fatal',
            code: `auth_${tok.code}`,
            message: 'ETA refused the stored credentials',
          };
    }
    let res: Response;
    try {
      res = await this.doFetch(`${ETA_HOSTS[this.env].api}/api/v1/receiptsubmissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.token}` },
        body: JSON.stringify({ receipts, signatures }),
      });
    } catch {
      return { kind: 'retry', reason: 'network', afterMs: null };
    }
    if (res.status === 401 && !retriedAuth) {
      tokenCache.delete(this.cacheKey());
      return this.submitReceipts(receipts, signatures, true);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
    if (res.status === 429)
      return { kind: 'retry', reason: 'throttled', afterMs: retryAfterMs ?? 5000 };
    if (res.status === 503)
      return { kind: 'retry', reason: 'unavailable', afterMs: retryAfterMs ?? 2000 };
    if (res.status >= 500) return { kind: 'retry', reason: `http_${res.status}`, afterMs: null };
    const body = (await res.json().catch(() => ({}))) as {
      submissionUUID?: string;
      acceptedDocuments?: EtaAccepted[];
      rejectedDocuments?: EtaRejected[];
      error?: { code?: string; message?: string };
      code?: string;
    };
    if (res.status === 202 || res.status === 200) {
      return {
        kind: 'ok',
        submissionUuid: body.submissionUUID ?? '',
        accepted: body.acceptedDocuments ?? [],
        rejected: body.rejectedDocuments ?? [],
      };
    }
    const code = String(body.error?.code ?? body.code ?? `http_${res.status}`).slice(0, 60);
    // Identical submission in the last 10 minutes: wait the advertised time, then look again.
    if (res.status === 422 && /duplicate/i.test(code)) {
      return {
        kind: 'retry',
        reason: 'duplicate_submission',
        afterMs: retryAfterMs ?? 10 * 60 * 1000,
      };
    }
    return {
      kind: 'fatal',
      code,
      message: String(body.error?.message ?? 'ETA rejected the request').slice(0, 300),
    };
  }

  /** Poll the verdict of a submission (read-only; rate limited like the other read APIs). */
  async getSubmission(submissionUuid: string): Promise<SubmissionVerdict> {
    const tok = await this.token();
    if (!tok.ok)
      return tok.transient
        ? { kind: 'retry', reason: `auth_${tok.code}`, afterMs: null }
        : { kind: 'fatal', code: `auth_${tok.code}` };
    let res: Response;
    try {
      res = await this.doFetch(
        `${ETA_HOSTS[this.env].api}/api/v1/receiptsubmissions/${encodeURIComponent(submissionUuid)}/details?PageNo=1&PageSize=100`,
        { method: 'GET', headers: { authorization: `Bearer ${tok.token}` } }
      );
    } catch {
      return { kind: 'retry', reason: 'network', afterMs: null };
    }
    const ra = Number(res.headers.get('retry-after'));
    if (res.status === 429)
      return { kind: 'retry', reason: 'throttled', afterMs: ra > 0 ? ra * 1000 : 5000 };
    if (res.status === 503)
      return { kind: 'retry', reason: 'unavailable', afterMs: ra > 0 ? ra * 1000 : 2000 };
    if (res.status >= 500) return { kind: 'retry', reason: `http_${res.status}`, afterMs: null };
    if (res.status === 401) {
      tokenCache.delete(this.cacheKey());
      return { kind: 'retry', reason: 'token_expired', afterMs: 0 };
    }
    if (res.status !== 200) return { kind: 'fatal', code: `http_${res.status}` };
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      receipts?: Array<{
        uuid: string;
        status: string;
        longId?: string;
        errors?: Array<{ error?: { errorCode?: string } }>;
      }>;
    };
    if (body.status === 'InProgress') return { kind: 'in_progress' };
    return {
      kind: 'done',
      receipts: (body.receipts ?? []).map(r => ({
        uuid: r.uuid,
        status: r.status,
        longId: r.longId,
        errorCode: r.errors?.[0]?.error?.errorCode?.slice(0, 60),
      })),
    };
  }
}
