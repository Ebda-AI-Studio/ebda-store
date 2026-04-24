export interface CreatedStore {
  id: string;
  name: string;
  slug: string;
  domain?: string;
}

export interface CreatedOwner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  temporaryPassword?: string;
}

export type Step = 'store' | 'owner' | 'review';

export interface FormData {
  storeName: string;
  storeSlug: string;
  customDomain: string;
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
}

export interface DomainStatus {
  verified: boolean;
  dnsRecords: Array<{ type: string; name: string; value: string }>;
}
