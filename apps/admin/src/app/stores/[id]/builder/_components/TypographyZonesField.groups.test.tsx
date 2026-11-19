// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('../../../../../lib/api', () => ({ apiFetch: vi.fn(), apiGet: vi.fn() }));

import { TypographyZonesField, ZONE_ORDER } from './TypographyZonesField';

afterEach(cleanup);

describe('typography zone groups (plan F14)', () => {
  it('render every zone exactly once, in storefront order, inside closed groups', () => {
    const { container } = render(
      <TypographyZonesField zones={{}} theme={undefined} onChange={vi.fn()} onReset={vi.fn()} />
    );
    const keys = [...container.querySelectorAll('[data-zone-key]')].map(e =>
      e.getAttribute('data-zone-key')
    );
    expect(keys).toEqual([...ZONE_ORDER]);
    const groups = container.querySelectorAll('[data-testid^="zone-group-"]');
    expect(groups.length).toBe(4);
    for (const g of groups) expect(g.getAttribute('data-state')).toBe('closed');
  });
});
