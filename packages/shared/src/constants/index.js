'use strict';
// Shared Constants
Object.defineProperty(exports, '__esModule', { value: true });
exports.ERROR_CODES =
  exports.HTTP_STATUS =
  exports.DEFAULT_STORE_SETTINGS =
  exports.SUPPORTED_CURRENCIES =
  exports.STORE_STATUSES =
  exports.USER_ROLES =
  exports.PRODUCT_STATUSES =
  exports.ORDER_STATUSES =
  exports.MAX_PAGE_SIZE =
  exports.DEFAULT_PAGE_SIZE =
  exports.API_BASE_PATH =
  exports.API_VERSION =
    void 0;
// API Endpoints
exports.API_VERSION = 'v1';
exports.API_BASE_PATH = `/api/${exports.API_VERSION}`;
// Pagination
exports.DEFAULT_PAGE_SIZE = 20;
exports.MAX_PAGE_SIZE = 100;
// Order Statuses
exports.ORDER_STATUSES = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
};
// Product Statuses
exports.PRODUCT_STATUSES = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  ARCHIVED: 'archived',
};
// User Roles
exports.USER_ROLES = {
  CUSTOMER: 'customer',
  STORE_ADMIN: 'store_admin',
  SUPER_ADMIN: 'super_admin',
};
// Store Statuses
exports.STORE_STATUSES = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
};
// Currencies
exports.SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'KWD', 'AED', 'SAR'];
// Default Store Settings
exports.DEFAULT_STORE_SETTINGS = {
  currency: 'USD',
  timezone: 'UTC',
  locale: 'en-US',
  theme: 'default',
};
// HTTP Status Codes
exports.HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};
// Error Codes
exports.ERROR_CODES = {
  // Auth errors
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  // Resource errors
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  CONFLICT: 'CONFLICT',
  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  // Rate limiting
  RATE_LIMITED: 'RATE_LIMITED',
};
//# sourceMappingURL=index.js.map
