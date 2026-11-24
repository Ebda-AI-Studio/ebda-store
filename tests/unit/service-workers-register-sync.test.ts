/**
 * Browsers warn (and may drop the handler) when a service-worker event listener is added AFTER the first evaluation of
 * the worker script ("Event handler of 'message' event must be added on the initial evaluation of worker script").
 * Every worker we ship registers message/push/notificationclick synchronously at top level, BEFORE any third-party
 * importScripts() or async work.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const WORKERS = [
  'apps/web/public/sw.js',
  'apps/orders/public/sw.js',
  'apps/web/public/OneSignalSDKWorker.js',
  'apps/admin/public/OneSignalSDKWorker.js',
  'apps/orders/public/OneSignalSDKWorker.js',
];

describe('service workers register their listeners on the first evaluation', () => {
  for (const f of WORKERS) {
    it(`${f}: message + push + notificationclick at top level, before importScripts`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      const importAt = src.indexOf('importScripts(');
      for (const ev of ['message', 'push', 'notificationclick']) {
        const m = new RegExp(`^self\\.addEventListener\\(\\s*'${ev}'`, 'm').exec(src);
        expect(m, `${f} has no top-level '${ev}' listener`).not.toBeNull();
        if (importAt >= 0) expect(m!.index).toBeLessThan(importAt);
      }
    });
  }
});
