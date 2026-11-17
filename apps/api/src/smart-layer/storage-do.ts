/**
 * `SmartLayerStorage` over the store's own StoreDO (Ruling SL-STORE-1). Each method is ONE named journal operation of
 * packages/repo `do/smart-layer.ts`, which runs as one `transactionSync` section in the DO, so every compare-and-set has a single winner.
 * `workers-do/smart-layer-storage.test.ts` runs the engine's executable storage contract against this class on the real DO.
 */
import type { SmartLayerStorage } from '@ebda/shared/smart-layer';
import type { SmartLayerClient } from '../lib/repo-factory';

// pq-allow(unused-export): the assistant adapter (next PR of the stack) imports it
export function doStorage(call: SmartLayerClient): SmartLayerStorage {
  return {
    appendTurn: async r => void (await call('appendTurn', [r])),
    loadTurns: async (s, c, n) => (await call('loadTurns', [s, c, n])) as never,
    appendAudit: async r => void (await call('appendAudit', [r])),
    loadAudits: async (s, since, n) => (await call('loadAudits', [s, since, n])) as never,
    putPreview: async r => void (await call('putPreview', [r])),
    getPreview: async (s, id) => (await call('getPreview', [s, id])) as never,
    transitionPreview: async (s, id, from, to) =>
      (await call('transitionPreview', [s, id, from, to])) as boolean,
    putApplied: async r => void (await call('putApplied', [r])),
    getApplied: async (s, id) => (await call('getApplied', [s, id])) as never,
    markUndone: async (s, id, now) => (await call('markUndone', [s, id, now])) as boolean,
    unmarkUndone: async (s, id) => (await call('unmarkUndone', [s, id])) as boolean,
    putApproval: async r => void (await call('putApproval', [r])),
    getApproval: async (s, id) => (await call('getApproval', [s, id])) as never,
    closeApproval: async (s, id, to) => (await call('closeApproval', [s, id, to])) as boolean,
    claimApproval: async (s, id, th, ph, now) =>
      (await call('claimApproval', [s, id, th, ph, now])) as never,
    recordDecision: async r => void (await call('recordDecision', [r])),
    loadDecisions: async (s, id) => (await call('loadDecisions', [s, id])) as never,
    bump: async (k, w, now) => (await call('bump', [k, w, now])) as number,
    eraseStore: async s => void (await call('eraseStore', [s])),
    eraseUser: async (s, u) => void (await call('eraseUser', [s, u])),
    purgeBefore: async c => (await call('purgeBefore', [c])) as number,
  };
}
