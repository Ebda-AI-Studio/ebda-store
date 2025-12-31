/**
 * Format price with currency
 */
export declare function formatPrice(amount: number, currency?: string, locale?: string): string;
/**
 * Generate URL-friendly slug from string
 */
export declare function slugify(text: string): string;
/**
 * Generate random string for IDs, tokens, etc.
 */
export declare function generateId(length?: number): string;
/**
 * Delay execution
 */
export declare function sleep(ms: number): Promise<void>;
/**
 * Safely parse JSON with fallback
 */
export declare function safeJsonParse<T>(json: string, fallback: T): T;
/**
 * Omit keys from object
 */
export declare function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K>;
/**
 * Pick keys from object
 */
export declare function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K>;
/**
 * Check if value is empty (null, undefined, empty string, empty array, empty object)
 */
export declare function isEmpty(value: unknown): boolean;
/**
 * Truncate string to max length
 */
export declare function truncate(str: string, maxLength: number, suffix?: string): string;
//# sourceMappingURL=index.d.ts.map
