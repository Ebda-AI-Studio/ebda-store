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

/** Service Binding RPC to accounts.ebda.app. NOT in identity contract v1 yet: see docs/privacy/erasure-export.md. */
export interface IdentityPort {
  /** Idempotent by requestId. Deletes users, refresh/verification tokens, passkeys and sessions. */
  eraseUser(userId: string, requestId: string): Promise<{ erased: number; remaining: number }>;
  exportUser(userId: string): Promise<Record<string, unknown[]>>;
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
  exportSubject(s: Subject): Promise<{ tables: Record<string, Array<Record<string, unknown>>> }>;
  eraseSubject(s: Subject): Promise<{ erased: Record<string, number>; remaining: number }>;
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
