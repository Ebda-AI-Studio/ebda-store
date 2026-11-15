/**
 * Every Store assistant tool agrees with the capability registry (plan 4 B6 step 1 "registry parity"): its capability is live, its policy is not
 * looser than the registry's, its undo class is not softer, no forbidden capability has a tool, a write tool has preview + apply, a reversible one
 * has an inverse, and no tool takes a store id from the model.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkAdapterContract, type SmartLayerAdapter } from '@ebda/shared/smart-layer';

vi.mock('@api/lib/repo-factory', () => ({
  storeDb: vi.fn(),
  storeSmartLayer: vi.fn(),
  storeRepo: vi.fn(),
}));
vi.mock('@api/cf/bindings', () => ({ cfBindings: () => undefined }));
vi.mock('@api/lib/search/embedding-provider', () => ({ getEmbeddingProvider: () => null }));

import { changeTools } from '@api/smart-layer/tools/change-tools';
import { readTools } from '@api/smart-layer/tools/read.tools';
import { storeRegistry } from '@api/smart-layer/registry';

const registry = storeRegistry();
const tools = [
  ...readTools({
    helpSearch: async () => [],
    registry,
    assistantCapability: 'ai.merchant-assistant',
  }),
  ...changeTools(),
];

describe('assistant tools vs the capability registry', () => {
  it('the engine adapter contract has no problem', () => {
    const problems = checkAdapterContract({
      registry: () => registry,
      tools: () => tools,
    } as unknown as SmartLayerAdapter);
    expect(problems).toEqual([]);
  });

  it('every reversible or compensating write tool declares an inverse', () => {
    const wrong = changeTools()
      .filter(t => (t.undo === 'reversible' || t.undo === 'compensating') && !t.inverse)
      .map(t => t.name);
    expect(wrong).toEqual([]);
  });

  it('no tool argument carries a store id (the store comes from the session, never the model)', () => {
    const bad = tools.filter(t => /store_?id/i.test(JSON.stringify(t.jsonSchema))).map(t => t.name);
    expect(bad).toEqual([]);
  });

  it('a write tool is backed by a capability the registry marks preview or confirm', () => {
    const bad = changeTools()
      .filter(t =>
        ['free', 'forbidden'].includes(registry.caps.get(t.capabilityId)?.policy ?? 'forbidden')
      )
      .map(t => t.name);
    expect(bad).toEqual([]);
  });
});
