/**
 * Entry point to the vendored shared observe module (`./foundation/observe`, byte-pinned by foundation.lock.json): Telegram alert text and
 * transport, the Sentry scrub, and the PII masks. A subpath like `@ebda/shared/smart-layer`: the shared barrel never pulls it in.
 * `import { telegramAlert, maskPhone } from '@ebda/shared/observe'` (Ruling FDN-OBSERVE-1).
 */
export * from './foundation/observe';
