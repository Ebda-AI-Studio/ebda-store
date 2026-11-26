/**
 * The URL/query scrubber for Sentry, PostHog and API logs now lives in the foundation (`observe/url-scrub`, vendored, byte-pinned by
 * foundation.lock.json; Ruling FDN-OBSERVE-1). This file keeps the old import path so no call site changes; its test
 * (`__tests__/sentry-url-scrub.test.ts`) still runs against it and proves the extraction is behaviour-identical.
 */
export * from '../foundation/observe/url-scrub';
