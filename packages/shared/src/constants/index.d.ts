export declare const API_VERSION = 'v1';
export declare const API_BASE_PATH = '/api/v1';
export declare const DEFAULT_PAGE_SIZE = 20;
export declare const MAX_PAGE_SIZE = 100;
export declare const ORDER_STATUSES: {
  readonly PENDING: 'pending';
  readonly CONFIRMED: 'confirmed';
  readonly PROCESSING: 'processing';
  readonly SHIPPED: 'shipped';
  readonly DELIVERED: 'delivered';
  readonly CANCELLED: 'cancelled';
  readonly REFUNDED: 'refunded';
};
export declare const PRODUCT_STATUSES: {
  readonly DRAFT: 'draft';
  readonly ACTIVE: 'active';
  readonly ARCHIVED: 'archived';
};
export declare const USER_ROLES: {
  readonly CUSTOMER: 'customer';
  readonly STORE_ADMIN: 'store_admin';
  readonly SUPER_ADMIN: 'super_admin';
};
export declare const STORE_STATUSES: {
  readonly ACTIVE: 'active';
  readonly INACTIVE: 'inactive';
  readonly SUSPENDED: 'suspended';
};
export declare const SUPPORTED_CURRENCIES: readonly ['USD', 'EUR', 'GBP', 'KWD', 'AED', 'SAR'];
export declare const DEFAULT_STORE_SETTINGS: {
  currency: string;
  timezone: string;
  locale: string;
  theme: string;
};
export declare const HTTP_STATUS: {
  readonly OK: 200;
  readonly CREATED: 201;
  readonly NO_CONTENT: 204;
  readonly BAD_REQUEST: 400;
  readonly UNAUTHORIZED: 401;
  readonly FORBIDDEN: 403;
  readonly NOT_FOUND: 404;
  readonly CONFLICT: 409;
  readonly UNPROCESSABLE_ENTITY: 422;
  readonly TOO_MANY_REQUESTS: 429;
  readonly INTERNAL_SERVER_ERROR: 500;
  readonly SERVICE_UNAVAILABLE: 503;
};
export declare const ERROR_CODES: {
  readonly INVALID_CREDENTIALS: 'INVALID_CREDENTIALS';
  readonly TOKEN_EXPIRED: 'TOKEN_EXPIRED';
  readonly TOKEN_INVALID: 'TOKEN_INVALID';
  readonly UNAUTHORIZED: 'UNAUTHORIZED';
  readonly FORBIDDEN: 'FORBIDDEN';
  readonly VALIDATION_ERROR: 'VALIDATION_ERROR';
  readonly INVALID_INPUT: 'INVALID_INPUT';
  readonly NOT_FOUND: 'NOT_FOUND';
  readonly ALREADY_EXISTS: 'ALREADY_EXISTS';
  readonly CONFLICT: 'CONFLICT';
  readonly INTERNAL_ERROR: 'INTERNAL_ERROR';
  readonly SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE';
  readonly RATE_LIMITED: 'RATE_LIMITED';
};
//# sourceMappingURL=index.d.ts.map
