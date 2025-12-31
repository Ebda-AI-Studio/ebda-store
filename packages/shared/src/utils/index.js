'use strict';
// Shared Utilities
Object.defineProperty(exports, '__esModule', { value: true });
exports.formatPrice = formatPrice;
exports.slugify = slugify;
exports.generateId = generateId;
exports.sleep = sleep;
exports.safeJsonParse = safeJsonParse;
exports.omit = omit;
exports.pick = pick;
exports.isEmpty = isEmpty;
exports.truncate = truncate;
/**
 * Format price with currency
 */
function formatPrice(amount, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(amount / 100);
}
/**
 * Generate URL-friendly slug from string
 */
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
/**
 * Generate random string for IDs, tokens, etc.
 */
function generateId(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
/**
 * Delay execution
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Safely parse JSON with fallback
 */
function safeJsonParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
/**
 * Omit keys from object
 */
function omit(obj, keys) {
  const result = { ...obj };
  keys.forEach(key => delete result[key]);
  return result;
}
/**
 * Pick keys from object
 */
function pick(obj, keys) {
  const result = {};
  keys.forEach(key => {
    if (key in obj) {
      result[key] = obj[key];
    }
  });
  return result;
}
/**
 * Check if value is empty (null, undefined, empty string, empty array, empty object)
 */
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
/**
 * Truncate string to max length
 */
function truncate(str, maxLength, suffix = '...') {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}
//# sourceMappingURL=index.js.map
