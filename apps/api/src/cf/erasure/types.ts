/**
 * PDPL 151/2020 erasure and export, designed against the Cloudflare storage (G10, Ruling INFRA-CF-1).
 * One job, five surfaces. Flag-gated (`PDPL_CF_ERASURE_ENABLED`) until the Store cuts over: until then the
 * Postgres path (`AuthService.eraseAccount` + privacy-propagation) remains the one that runs.
 */
export interface MerchantSubject {
  kind: 'merchant';
  requestId: string;
  storeId: string;
  /** The owner's identity user id (ebda-identity). */
  ownerUserId: string;
  /** Staff user ids whose identity records go with the merchant (optional). */
  staffUserIds?: string[];
}

export interface CustomerSubject {
  kind: 'customer';
  requestId: string;
  /** HMAC-SHA256(SUITE_BUYER_KEY_SECRET, E.164 phone): the CI key and the WhatsApp key. */
  buyerKey: string;
  phoneE164?: string;
  email?: string;
  /** Identity user id when the customer has an account. */
  userId?: string;
  /** Stores to scrub. Omitted = derived from the CI buyer index (the one cross-store index). */
  storeIds?: string[];
}

export type Subject = MerchantSubject | CustomerSubject;

export interface SurfaceResult {
  surface: string;
  /** Records erased (rows, objects, entries). */
  erased: number;
  /** Records still matching the subject after the erase. Anything above 0 fails the job. */
  remaining: number;
  note?: string;
}

export interface ExportPart {
  surface: string;
  /** NDJSON text, one record per line. */
  ndjson: string;
  records: number;
}

export interface ErasureSurface {
  readonly name: string;
  exportSubject(s: Subject): Promise<ExportPart>;
  eraseSubject(s: Subject): Promise<SurfaceResult>;
}

/** Structural R2 bucket (workers-types globals are not loaded in this package). */
export interface R2BucketLike {
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown>;
  get(
    key: string
  ): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

/** What `Accounts.exportUser` returns (identity contract addendum v1.1): one array per table, no secrets. */
export interface IdentityExport {
  users: unknown[];
  sessions: unknown[];
  refresh_tokens: unknown[];
  verification_tokens: unknown[];
  passkey_credentials: unknown[];
  /** Platform-admin lifecycle events naming this account (Ruling ID-20); absent from an identity service older than it. */
  admin_audit?: unknown[];
}

/**
 * Service Binding RPC `Accounts` (accounts.ebda.app), EXACTLY the shape of identity contract addendum v1.1
 * (business/ebda/plans/2026-10-24-ebda-identity-token-contract.md). `remaining` is re-counted by the identity
 * service after the delete: anything above 0 is a failed surface. A repeat call is `{ erased: false, remaining: 0 }`.
 */
export interface IdentityPort {
  eraseUser(userId: string, requestId?: string): Promise<{ erased: boolean; remaining: number }>;
  exportUser(userId: string): Promise<IdentityExport>;
}

/** Email suppression entries (G6 owns the table). Erasure keeps the suppression, drops the address. */
export interface SuppressionPort {
  /** Replace the stored address with a keyed hash; the suppression keeps working. */
  tombstone(storeId: string | null, email: string): Promise<{ rows: number }>;
  exportFor(email: string): Promise<Array<Record<string, unknown>>>;
  /** Rows still holding the plain address. */
  remainingPlain(email: string): Promise<number>;
}

export interface StoreDoStub {
  /** READ-ONLY money-in-flight gate of one store (Ruling NZ-D20): counts only, writes nothing, closes nothing. */
  moneyInFlight(): Promise<Record<string, number>>;
  exportSubject(s: Subject): Promise<{ tables: Record<string, Array<Record<string, unknown>>> }>;
  eraseSubject(s: Subject): Promise<{
    erased: Record<string, number>;
    remaining: number;
    refused?: Record<string, number>;
  }>;
}

export interface ErasureEnv {
  PDPL_CF_ERASURE_ENABLED?: string;
  STORE_DO?: { idFromName(n: string): unknown; get(id: unknown): unknown };
  /** ebda-media: merchant images under stores/<storeId>/. */
  MEDIA_BUCKET?: unknown;
  /** ebda-ci: Customer Intelligence (docs/plans/2026-10-28-customer-intelligence.md). */
  CI_BUCKET?: unknown;
  /** ebda-private: erasure ledger and export bundles. */
  STORE_BACKUPS?: unknown;
}
