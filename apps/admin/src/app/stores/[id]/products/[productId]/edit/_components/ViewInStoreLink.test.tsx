// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ViewInStoreLink } from './ViewInStoreLink';

afterEach(cleanup);

describe('ViewInStoreLink', () => {
  it('links to the public page for an active product', () => {
    render(
      <ViewInStoreLink storeHost={{ slug: 'amelia' }} slug="ring" status="active" label="View" />
    );
    expect(screen.getByText('View').getAttribute('href')).toContain('/products/ring');
  });
  it.each(['draft', 'archived'])('renders nothing for a %s product (public page 404s)', status => {
    render(
      <ViewInStoreLink storeHost={{ slug: 'amelia' }} slug="ring" status={status} label="View" />
    );
    expect(screen.queryByText('View')).toBeNull();
  });
  it('renders nothing without a store host', () => {
    render(<ViewInStoreLink storeHost={null} slug="ring" status="active" label="View" />);
    expect(screen.queryByText('View')).toBeNull();
  });
});
