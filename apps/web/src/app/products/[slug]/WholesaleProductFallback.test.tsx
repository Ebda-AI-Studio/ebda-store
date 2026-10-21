// @vitest-environment jsdom
/**
 * B2B review I2: the product 404 shows a wholesale-only product to an approved buyer, and nothing else changes.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  auth: { isAuthenticated: true } as { isAuthenticated: boolean } | null,
  getWholesaleProduct: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ slug: 'bulk%20tea-ab12' }) }));
vi.mock('../../../contexts/AuthContext', () => ({ useOptionalAuth: () => h.auth }));
vi.mock('@/lib/api', () => ({ api: { getWholesaleProduct: h.getWholesaleProduct } }));
vi.mock('./ProductDetailClient', () => ({
  default: ({ initialProduct }: { initialProduct: { name: string } }) => (
    <div data-testid="pdp">{initialProduct.name}</div>
  ),
}));

import WholesaleProductFallback from './WholesaleProductFallback';

const notFound = <div data-testid="404">not found</div>;

beforeEach(() => {
  h.auth = { isAuthenticated: true };
  h.getWholesaleProduct.mockReset();
});
afterEach(cleanup);

describe('WholesaleProductFallback', () => {
  it('an approved buyer gets the product page (the slug is decoded before the call)', async () => {
    h.getWholesaleProduct.mockResolvedValue({
      success: true,
      data: { product: { id: 'p', name: 'Bulk tea' } },
    });
    render(<WholesaleProductFallback>{notFound}</WholesaleProductFallback>);
    await waitFor(() => expect(screen.getByTestId('pdp').textContent).toBe('Bulk tea'));
    expect(h.getWholesaleProduct).toHaveBeenCalledWith('bulk tea-ab12');
    expect(screen.queryByTestId('404')).toBeNull();
  });

  it('a signed-in shopper who is not a member keeps the 404', async () => {
    h.getWholesaleProduct.mockResolvedValue({ success: false, error: { code: 'NOT_FOUND' } });
    render(<WholesaleProductFallback>{notFound}</WholesaleProductFallback>);
    await waitFor(() => expect(h.getWholesaleProduct).toHaveBeenCalled());
    expect(screen.getByTestId('404')).toBeTruthy();
    expect(screen.queryByTestId('pdp')).toBeNull();
  });

  it('an anonymous visitor keeps the 404 and never calls the buyer route', () => {
    h.auth = { isAuthenticated: false };
    render(<WholesaleProductFallback>{notFound}</WholesaleProductFallback>);
    expect(screen.getByTestId('404')).toBeTruthy();
    expect(h.getWholesaleProduct).not.toHaveBeenCalled();
  });

  it('outside an AuthProvider it renders the 404 and does not throw', () => {
    h.auth = null;
    render(<WholesaleProductFallback>{notFound}</WholesaleProductFallback>);
    expect(screen.getByTestId('404')).toBeTruthy();
    expect(h.getWholesaleProduct).not.toHaveBeenCalled();
  });
});
