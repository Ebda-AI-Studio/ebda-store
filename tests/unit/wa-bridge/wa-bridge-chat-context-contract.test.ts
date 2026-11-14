/**
 * Store side of the Chat-agent context contract (Ruling CHAT-AGENT-1). `tests/vectors/ebda-wa/bridge-chat-context-v2.json` is a recorded
 * list of calls and exact answers for `searchProducts`, `getStorePolicies` and `getCustomerProfile`. ebda-whatsapp vendors the SAME file
 * byte for byte (sha pinned in SHA256SUMS on both sides) and replays it through its adapter and schemas. Kept apart from `bridge-v1.json`
 * so the older fixture (and ebda-whatsapp pr 67's re-vendor of it) is untouched.
 * Regenerate with `WA_BRIDGE_REGEN=1`, then update SHA256SUMS and the vendored copy.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('../../../apps/api/src/lib/derived-secret', () => ({
  derivedSecret: () => Buffer.alloc(32, 7),
}));

import { createBridge } from '../../../apps/api/src/lib/wa/bridge/service';
import { makeFakePort } from './fake-port';
import { CHAT_CONTEXT_CASES } from './chat-context-cases';

const FIXTURE = path.resolve(__dirname, '../../vectors/ebda-wa/bridge-chat-context-v2.json');
const SUMS = path.resolve(__dirname, '../../vectors/ebda-wa/SHA256SUMS');
const bridge = () =>
  createBridge({
    port: makeFakePort().port,
    storefrontUrl: async () => 'https://dar-mona.ebda.app',
    buyerKeySecret: () => 'ebda-suite-buyer-key-test-v1',
  });
const call = (b: ReturnType<typeof bridge>, m: string, a: unknown[]) =>
  (b as never as Record<string, (...x: unknown[]) => Promise<unknown>>)[m]!(...a);
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('chat-context contract vectors', () => {
  if (process.env.WA_BRIDGE_REGEN) {
    it('regenerates the fixture', async () => {
      const b = bridge();
      const cases = [];
      for (const c of CHAT_CONTEXT_CASES)
        cases.push({ ...c, expect: plain(await call(b, c.method, c.args)) });
      writeFileSync(FIXTURE, JSON.stringify({ version: 2, cases }, null, 1) + '\n');
    });
    return;
  }
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    cases: Array<{ name: string; method: string; args: unknown[]; expect: unknown }>;
  };
  it('covers every case in chat-context-cases.ts, in order', () => {
    expect(fx.cases.map(c => [c.name, c.method, c.args])).toEqual(
      CHAT_CONTEXT_CASES.map(c => [c.name, c.method, plain(c.args)])
    );
  });
  it('replays to the recorded answers', async () => {
    const b = bridge();
    for (const c of fx.cases)
      expect(plain(await call(b, c.method, c.args)), c.name).toEqual(c.expect);
  });
  it('the fixture sha is pinned', () => {
    expect(readFileSync(SUMS, 'utf8')).toContain(
      `${createHash('sha256').update(readFileSync(FIXTURE)).digest('hex')}  bridge-chat-context-v2.json`
    );
  });
});
