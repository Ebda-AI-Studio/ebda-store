import { describe, it, expect } from 'vitest';
import { buildPerStoreBody } from './route';

/**
 * Unit tests for the llms.txt per-store body builder — specifically the
 * agent_checkout MCP-endpoint advertisement, mirroring the existing
 * agent_feed conditional section. Exercises the pure builder function
 * directly (no Next.js request/response, no `next/headers`, no network) —
 * the preferred TDD path per the task-7 brief.
 */
describe('buildPerStoreBody — agent_checkout MCP advertisement', () => {
  const baseStore = {
    id: 'store_1',
    name: 'Test Store',
    slug: 'test-store',
    status: 'active',
  };

  it('advertises the /mcp/<slug> endpoint + all 7 tools when agent_checkout is enabled', () => {
    const body = buildPerStoreBody(
      { ...baseStore, enabledFeatures: ['agent_checkout'] },
      [],
      [],
      0
    );

    expect(body).toContain('## Agentic checkout (MCP)');
    expect(body).toContain(`/mcp/${baseStore.slug}`);
    expect(body).toContain('search_products');
    expect(body).toContain('get_product');
    expect(body).toContain('get_store_info');
    expect(body).toContain('add_to_cart');
    expect(body).toContain('view_cart');
    expect(body).toContain('place_order');
    expect(body).toContain('get_order_status');
  });

  /**
   * heading-is-a-contract: llms.txt is the ONLY discovery surface for this
   * endpoint, so what it promises about authentication is an assertion about
   * the API. If the write tools need `x-agent-key` and this file does not say
   * so, every agent that reads it builds against a contract that no longer
   * exists. These two tests are what stop the copy and the enforcement drifting.
   */
  it('states the read/write split and the x-agent-key requirement by default', () => {
    const body = buildPerStoreBody(
      { ...baseStore, enabledFeatures: ['agent_checkout'] },
      [],
      [],
      0
    );

    expect(body).toContain('Read tools (no credential):');
    expect(body).toContain('Write tools (credential required): add_to_cart, place_order');
    expect(body).toContain('x-agent-key');
    // The read list must NOT claim a credential is needed for reads.
    expect(body).toContain(
      'Read tools (no credential): search_products, get_product, get_store_info, view_cart, get_order_status'
    );
  });

  it('drops the credential requirement from the advertisement when the store has the open-writes escape hatch on', () => {
    const body = buildPerStoreBody(
      { ...baseStore, enabledFeatures: ['agent_checkout', 'agent_checkout_open_writes'] },
      [],
      [],
      0
    );

    expect(body).toContain('Write tools (no credential required on this store)');
    expect(body).not.toContain('x-agent-key');
    expect(body).not.toContain('Write tools (credential required)');
  });

  it('omits the MCP section when agent_checkout is not in enabledFeatures', () => {
    const body = buildPerStoreBody({ ...baseStore, enabledFeatures: ['agent_feed'] }, [], [], 0);

    expect(body).not.toContain('## Agentic checkout (MCP)');
    expect(body).not.toContain('/mcp/');
  });

  it('omits the MCP section when enabledFeatures is entirely absent', () => {
    const body = buildPerStoreBody({ ...baseStore }, [], [], 0);

    expect(body).not.toContain('## Agentic checkout (MCP)');
  });
});
